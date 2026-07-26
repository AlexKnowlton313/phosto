import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { Folder, Photo, Share } from './types.js';

const TABLE = process.env.TABLE_NAME!;

export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const folderPk = (folderId: string) => `FOLDER#${folderId}`;
const sharePk = (tokenHash: string) => `SHARE#${tokenHash}`;

/**
 * Keyed on uploadedAt, not takenAt, deliberately. The derive Lambda often corrects
 * takenAt once it has read EXIF, and a sort key cannot be updated in place — it
 * would mean delete-then-put on every photo. uploadedAt never changes, so the key
 * is stable and callers sort by takenAt after reading. Folders hold hundreds to a
 * few thousand photos, so that sort is free.
 */
const photoSk = (uploadedAt: string, photoId: string) =>
  `PHOTO#${uploadedAt}#${photoId}`;

/**
 * Turns a patch object into the three fields an UpdateCommand needs, skipping
 * undefined values so a partial patch never blanks a field it did not mention.
 */
function setExpression(patch: Record<string, unknown>) {
  const fields = Object.entries(patch).filter(([, v]) => v !== undefined);
  return {
    UpdateExpression: `SET ${fields.map(([k]) => `#${k} = :${k}`).join(', ')}`,
    ExpressionAttributeNames: Object.fromEntries(fields.map(([k]) => [`#${k}`, k])),
    ExpressionAttributeValues: Object.fromEntries(fields.map(([k, v]) => [`:${k}`, v])),
  };
}

const hasPatch = (patch: object) =>
  Object.values(patch).some((v) => v !== undefined);

// --------------------------------------------------------------------- folders

/**
 * `ifAbsent` makes this a create rather than an overwrite, and swallows the
 * refusal. A folder with a fixed id is created lazily by whichever request needs
 * it first, and a plain Put would let a stale read from a second request clobber
 * the live item back to photoCount 0 — losing that race is the correct outcome,
 * not an error.
 */
export async function putFolder(
  folder: Folder,
  { ifAbsent = false } = {},
): Promise<void> {
  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          pk: folderPk(folder.folderId),
          sk: 'META',
          gsi1pk: 'ROOT',
          gsi1sk: `${folder.createdAt}#${folder.folderId}`,
          ...folder,
        },
        ...(ifAbsent ? { ConditionExpression: 'attribute_not_exists(pk)' } : {}),
      }),
    );
  } catch (err) {
    if (!ifAbsent || (err as Error).name !== 'ConditionalCheckFailedException') throw err;
  }
}

export async function getFolder(folderId: string): Promise<Folder | null> {
  const res = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { pk: folderPk(folderId), sk: 'META' } }),
  );
  return (res.Item as Folder) ?? null;
}

export async function listFolders(): Promise<Folder[]> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: 'gsi1',
      KeyConditionExpression: 'gsi1pk = :root',
      ExpressionAttributeValues: { ':root': 'ROOT' },
      ScanIndexForward: false,
    }),
  );
  return (res.Items ?? []) as Folder[];
}

export async function updateFolder(
  folderId: string,
  patch: Partial<Pick<Folder, 'name' | 'coverPhotoId'>>,
): Promise<void> {
  if (!hasPatch(patch)) return;

  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { pk: folderPk(folderId), sk: 'META' },
      ...setExpression({ ...patch, updatedAt: new Date().toISOString() }),
      ConditionExpression: 'attribute_exists(pk)',
    }),
  );
}

/**
 * The photoCount bump as a bare command shape, so `movePhoto` can put the same
 * guarded expression inside its transaction rather than restating it. The
 * condition is what makes a move fail cleanly when a folder is deleted mid-flight.
 */
const photoCountUpdate = (folderId: string, delta: number, extra = '') => ({
  TableName: TABLE,
  Key: { pk: folderPk(folderId), sk: 'META' },
  UpdateExpression: `SET photoCount = if_not_exists(photoCount, :zero) + :delta${extra}`,
  ExpressionAttributeValues: { ':zero': 0, ':delta': delta },
  ConditionExpression: 'attribute_exists(pk)',
});

export async function bumpPhotoCount(folderId: string, delta: number): Promise<void> {
  await ddb.send(new UpdateCommand(photoCountUpdate(folderId, delta)));
}

/**
 * Takes the folder's shares with it. A share hangs off `SHARE#<tokenHash>` with
 * only a gsi1 pointer back at the folder, so dropping the META item alone leaves
 * rows that mean nothing until their TTL fires — up to 365 days. Cascading here
 * rather than in the route so no later caller can delete a folder and forget.
 * Deletion is restricted to empty folders, so the share list is small.
 */
export async function deleteFolder(folderId: string): Promise<void> {
  for (const share of await listSharesForFolder(folderId)) {
    await deleteShare(share.tokenHash);
  }

  await ddb.send(
    new DeleteCommand({ TableName: TABLE, Key: { pk: folderPk(folderId), sk: 'META' } }),
  );
}

// ---------------------------------------------------------------------- photos

export async function putPhoto(photo: Photo): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        pk: folderPk(photo.folderId),
        sk: photoSk(photo.uploadedAt, photo.photoId),
        ...photo,
      },
    }),
  );
}

export async function listPhotos(folderId: string): Promise<Photo[]> {
  const items: Photo[] = [];
  let cursor: Record<string, unknown> | undefined;

  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': folderPk(folderId), ':prefix': 'PHOTO#' },
        ExclusiveStartKey: cursor,
        ScanIndexForward: false,
      }),
    );
    items.push(...((res.Items ?? []) as Photo[]));
    cursor = res.LastEvaluatedKey;
  } while (cursor);

  return items;
}

export async function findPhoto(
  folderId: string,
  photoId: string,
): Promise<Photo | null> {
  // photoId is not part of the sort key prefix, so this is a filtered query rather
  // than a point read. Folders are small enough that it stays a single page.
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      FilterExpression: 'photoId = :photoId',
      ExpressionAttributeValues: {
        ':pk': folderPk(folderId),
        ':prefix': 'PHOTO#',
        ':photoId': photoId,
      },
    }),
  );
  return ((res.Items ?? [])[0] as Photo) ?? null;
}

export async function updatePhoto(
  photo: Photo,
  patch: Partial<Photo>,
): Promise<void> {
  if (!hasPatch(patch)) return;

  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { pk: folderPk(photo.folderId), sk: photoSk(photo.uploadedAt, photo.photoId) },
      ...setExpression(patch),
    }),
  );
}

/**
 * Repoints one photo record at another folder, atomically.
 *
 * `pk` carries the folder, so this crosses partitions and cannot be an update —
 * it is a delete plus a put. Both photoCounts move with it in the same
 * transaction, so a failure can never leave a photo counted twice or listed in
 * two folders. The sort key is unchanged: `uploadedAt` is half of it and is
 * deliberately not `takenAt` (see `photoSk`), so rewriting it would reorder the
 * photo for nothing.
 *
 * Moving the record is only the first step of a move — the S3 objects still have
 * to follow — so this is not exported as a whole-move primitive.
 */
export async function movePhoto(
  source: Folder,
  photo: Photo,
  toFolderId: string,
): Promise<void> {
  const key = { sk: photoSk(photo.uploadedAt, photo.photoId) };

  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        { Delete: { TableName: TABLE, Key: { pk: folderPk(photo.folderId), ...key } } },
        {
          Put: {
            TableName: TABLE,
            Item: {
              // `photo` is the raw item off a Query, so it still carries the
              // source `pk` — spread it FIRST or it overwrites the destination
              // key and the transaction becomes two operations on one item,
              // which DynamoDB rejects outright. The Photo type does not
              // declare pk/sk, so tsc cannot catch the wrong order here.
              ...photo,
              pk: folderPk(toFolderId),
              ...key,
              folderId: toFolderId,
              // Dropped, not carried: the derivatives under the destination
              // prefix do not exist until the copy of the original retriggers
              // the derive Lambda. Claiming ready here would point the grid at
              // keys that are not written yet.
              derivedAt: undefined,
            },
          },
        },
        {
          Update: photoCountUpdate(
            photo.folderId,
            -1,
            // A cover pointing into another folder renders as a broken tile.
            source.coverPhotoId === photo.photoId ? ' REMOVE coverPhotoId' : '',
          ),
        },
        { Update: photoCountUpdate(toFolderId, 1) },
      ],
    }),
  );
}

export async function deletePhoto(photo: Photo): Promise<void> {
  await ddb.send(
    new DeleteCommand({
      TableName: TABLE,
      Key: { pk: folderPk(photo.folderId), sk: photoSk(photo.uploadedAt, photo.photoId) },
    }),
  );
}

// ---------------------------------------------------------------------- shares

export async function putShare(share: Share): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        pk: sharePk(share.tokenHash),
        sk: 'META',
        gsi1pk: folderPk(share.folderId),
        gsi1sk: `SHARE#${share.createdAt}`,
        ...share,
      },
    }),
  );
}

export async function getShare(tokenHash: string): Promise<Share | null> {
  const res = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { pk: sharePk(tokenHash), sk: 'META' } }),
  );
  const share = (res.Item as Share) ?? null;
  if (!share) return null;

  // DynamoDB TTL deletion can lag by up to 48 hours, so never trust it for access
  // control — check the expiry here too.
  if (share.expiresAt <= Math.floor(Date.now() / 1000)) return null;
  return share;
}

export async function listSharesForFolder(folderId: string): Promise<Share[]> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: 'gsi1',
      KeyConditionExpression: 'gsi1pk = :pk AND begins_with(gsi1sk, :prefix)',
      ExpressionAttributeValues: { ':pk': folderPk(folderId), ':prefix': 'SHARE#' },
      ScanIndexForward: false,
    }),
  );
  return (res.Items ?? []) as Share[];
}

export async function deleteShare(tokenHash: string): Promise<void> {
  await ddb.send(
    new DeleteCommand({ TableName: TABLE, Key: { pk: sharePk(tokenHash), sk: 'META' } }),
  );
}
