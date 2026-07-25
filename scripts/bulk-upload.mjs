#!/usr/bin/env node
/**
 * Imports an existing library straight into the bucket, bypassing the browser.
 *
 * This talks to S3 and DynamoDB with your AWS credentials rather than going
 * through the API, because pushing 18 GB through presigned URLs one file at a time
 * is slow and pointless when the uploader is the bucket owner. The derive Lambda
 * still fires on every object, so derivatives and EXIF are produced exactly as
 * they would be for a browser upload.
 *
 * Usage:
 *   node scripts/bulk-upload.mjs --folder "Summer 2026" --src /Volumes/Untitled/DCIM/100_FUJI
 *   node scripts/bulk-upload.mjs --folder "Summer 2026" --src ./photos --dry-run
 *
 * Safe to re-run: completed uploads are recorded in scripts/.upload-state.json and
 * skipped on the next pass, so an interrupted import resumes where it stopped.
 */
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const STATE_PATH = join(here, '.upload-state.json');

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'hif']);
const RAW_EXTS = new Set(['raf', 'dng', 'cr2', 'cr3', 'nef', 'arw', 'orf', 'rw2']);

const CONTENT_TYPES = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  heic: 'image/heic', heif: 'image/heif', hif: 'image/heif',
  raf: 'image/x-fuji-raf', dng: 'image/x-adobe-dng', cr2: 'image/x-canon-cr2',
  cr3: 'image/x-canon-cr3', nef: 'image/x-nikon-nef', arw: 'image/x-sony-arw',
  orf: 'image/x-olympus-orf', rw2: 'image/x-panasonic-rw2',
};

/** Parallel file uploads. Each one may itself run multipart concurrency. */
const CONCURRENCY = 4;

// --------------------------------------------------------------------- args

function parseArgs(argv) {
  const args = { dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--folder') args.folder = argv[++i];
    else if (flag === '--src') args.src = argv[++i];
    else if (flag === '--dry-run') args.dryRun = true;
    else if (flag === '--reset') args.reset = true;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

if (!args.folder || !args.src) {
  console.error('Usage: bulk-upload.mjs --folder "<name>" --src <directory> [--dry-run] [--reset]');
  process.exit(1);
}

const config = JSON.parse(readFileSync(join(repoRoot, 'infra/config.json'), 'utf8'));

// --------------------------------------------------------------- discovery

const extOf = (name) => extname(name).slice(1).toLowerCase();

/**
 * Groups a directory into photos.
 *
 * A JPEG and a RAW sharing a basename (XT300024.JPG + XT300024.RAF) are one photo
 * with two files, which is what makes the RAW toggle meaningful rather than
 * showing every frame twice.
 *
 * macOS writes AppleDouble sidecars named `._NAME` onto FAT-formatted cards. They
 * are 4KB of metadata with a real image extension, so they must be filtered out or
 * they upload as corrupt photos.
 */
async function scan(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const groups = new Map();

  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith('._') || entry.name.startsWith('.')) continue;

    const ext = extOf(entry.name);
    const isImage = IMAGE_EXTS.has(ext);
    const isRaw = RAW_EXTS.has(ext);
    if (!isImage && !isRaw) continue;

    const stem = basename(entry.name, extname(entry.name));
    const group = groups.get(stem) ?? { stem, image: null, raw: null };

    const file = {
      path: join(dir, entry.name),
      name: entry.name,
      ext,
      size: statSync(join(dir, entry.name)).size,
    };

    if (isRaw) group.raw = file;
    else group.image = file;

    groups.set(stem, group);
  }

  return [...groups.values()].sort((a, b) => a.stem.localeCompare(b.stem));
}

// ------------------------------------------------------------------- state

const loadState = () =>
  !args.reset && existsSync(STATE_PATH)
    ? JSON.parse(readFileSync(STATE_PATH, 'utf8'))
    : { folderId: null, done: {} };

const state = loadState();
const saveState = () => writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));

// ------------------------------------------------------------------ stack

async function resolveStack() {
  const cfn = new CloudFormationClient({ region: config.region });
  const res = await cfn.send(new DescribeStacksCommand({ StackName: 'PhostoStack' }));
  const outputs = Object.fromEntries(
    (res.Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey, o.OutputValue]),
  );
  if (!outputs.BucketName || !outputs.TableName) {
    throw new Error('PhostoStack outputs missing — has the stack finished deploying?');
  }
  return outputs;
}

// ------------------------------------------------------------------ upload

const s3 = new S3Client({ region: config.region });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: config.region }), {
  marshallOptions: { removeUndefinedValues: true },
});

async function putObject(bucket, key, file) {
  const upload = new Upload({
    client: s3,
    params: {
      Bucket: bucket,
      Key: key,
      Body: createReadStream(file.path),
      ContentType: CONTENT_TYPES[file.ext] ?? 'application/octet-stream',
    },
    // 8MB parts: a 30MB RAF becomes 4 parts, small enough to retry cheaply.
    partSize: 8 * 1024 * 1024,
    queueSize: 2,
  });
  await upload.done();
}

const formatBytes = (bytes) => `${(bytes / 1024 ** 3).toFixed(2)} GB`;

async function main() {
  const src = resolve(args.src);
  const groups = await scan(src);

  const imageBytes = groups.reduce((sum, g) => sum + (g.image?.size ?? 0), 0);
  const rawBytes = groups.reduce((sum, g) => sum + (g.raw?.size ?? 0), 0);
  const paired = groups.filter((g) => g.image && g.raw).length;
  const rawOnly = groups.filter((g) => !g.image && g.raw).length;

  console.log(`Source        ${src}`);
  console.log(`Photos        ${groups.length}  (${paired} JPEG+RAW pairs, ${rawOnly} RAW-only)`);
  console.log(`Originals     ${formatBytes(imageBytes)}`);
  console.log(`RAW           ${formatBytes(rawBytes)}  → Glacier IR after 30 days`);
  console.log(`Total         ${formatBytes(imageBytes + rawBytes)}`);

  const alreadyDone = groups.filter((g) => state.done[g.stem]).length;
  if (alreadyDone) console.log(`Resuming      ${alreadyDone} already uploaded, will skip`);

  if (args.dryRun) {
    console.log('\n--dry-run: nothing uploaded.');
    return;
  }

  const outputs = await resolveStack();
  const bucket = outputs.BucketName;
  const table = outputs.TableName;

  // Reuse the folder across resumed runs so a retry does not create a duplicate.
  const now = new Date().toISOString();
  if (!state.folderId) {
    state.folderId = randomUUID();
    await ddb.send(
      new PutCommand({
        TableName: table,
        Item: {
          pk: `FOLDER#${state.folderId}`,
          sk: 'META',
          gsi1pk: 'ROOT',
          gsi1sk: `${now}#${state.folderId}`,
          folderId: state.folderId,
          name: args.folder,
          createdAt: now,
          updatedAt: now,
          photoCount: 0,
          rawVisibleDefault: false,
        },
      }),
    );
    saveState();
    console.log(`\nCreated folder "${args.folder}" (${state.folderId})`);
  } else {
    console.log(`\nUsing existing folder ${state.folderId}`);
  }

  const pending = groups.filter((g) => !state.done[g.stem]);
  let completed = 0;
  let cursor = 0;

  const worker = async () => {
    while (cursor < pending.length) {
      const group = pending[cursor++];
      const photoId = randomUUID();

      try {
        // The photo record must exist before the objects land: the derive Lambda
        // looks it up by key and drops the event if there is nothing to update.
        await ddb.send(
          new PutCommand({
            TableName: table,
            Item: {
              pk: `FOLDER#${state.folderId}`,
              sk: `PHOTO#${now}#${photoId}`,
              folderId: state.folderId,
              photoId,
              basename: group.stem,
              kind: group.image ? 'image' : 'raw-only',
              takenAt: statSync((group.image ?? group.raw).path).mtime.toISOString(),
              uploadedAt: now,
              hasRaw: Boolean(group.raw),
              originalExt: group.image?.ext,
              originalBytes: group.image?.size,
              rawExt: group.raw?.ext,
              rawBytes: group.raw?.size,
            },
          }),
        );

        if (group.image) {
          await putObject(bucket, `orig/${state.folderId}/${photoId}.${group.image.ext}`, group.image);
        }
        if (group.raw) {
          await putObject(bucket, `raw/${state.folderId}/${photoId}.${group.raw.ext}`, group.raw);
        }

        state.done[group.stem] = photoId;
        completed += 1;
        if (completed % 10 === 0) saveState();

        process.stdout.write(
          `\r  ${completed}/${pending.length} uploaded — ${group.stem}          `,
        );
      } catch (err) {
        console.error(`\nFailed on ${group.stem}: ${err.message}`);
        throw err;
      }
    }
  };

  try {
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker),
    );
  } finally {
    saveState();
  }

  await ddb.send(
    new UpdateCommand({
      TableName: table,
      Key: { pk: `FOLDER#${state.folderId}`, sk: 'META' },
      UpdateExpression: 'SET photoCount = :count',
      ExpressionAttributeValues: { ':count': Object.keys(state.done).length },
    }),
  );

  console.log(`\n\nDone. ${completed} photos uploaded.`);
  console.log('Derivatives are generated asynchronously — the grid fills in as they land.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
