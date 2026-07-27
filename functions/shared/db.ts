import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  BatchGetCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { Folder, Membership, Photo, Share } from './types.js';

const TABLE = process.env.TABLE_NAME!;

export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const folderPk = (folderId: string) => `FOLDER#${folderId}`;
const sharePk = (tokenHash: string) => `SHARE#${tokenHash}`;
const photoPk = (photoId: string) => `PHOTO#${photoId}`;

/**
 * Every photo hangs off one `gsi1` partition, which is what makes "all photos" a
 * single query now that no folder owns anything.
 *
 * ponytail: single LIB partition, bucket by year if the library outgrows one query.
 * At 835 photos it is one page and a fraction of a read unit.
 */
const LIBRARY_PK = 'LIB';

/**
 * A membership's sort position inside its folder, and the reason the `PHOTO#`
 * prefix is here: `gsi1pk = FOLDER#<id>` now holds both the folder's shares
 * (`SHARE#…`) and its photos, so each is a `begins_with` query on the same
 * overloaded partition.
 *
 * Keyed on uploadedAt, not takenAt, deliberately. The derive Lambda often corrects
 * takenAt once it has read EXIF, and a sort key cannot be updated in place — it
 * would mean delete-then-put on every membership the photo has. uploadedAt never
 * changes, so the key is stable and callers sort by takenAt after reading.
 */
const membershipGsi1sk = (uploadedAt: string, photoId: string) =>
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
 * Its own function because `setExpression` can only SET: an `undefined` in a
 * patch is skipped, so there is no way to spell "drop this field" through
 * `updateFolder`. Hiding the frame a roll uses as its cover needs exactly that,
 * or the roll card goes on advertising the frame just taken out of circulation.
 */
export async function clearCover(folderId: string): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { pk: folderPk(folderId), sk: 'META' },
      UpdateExpression: 'REMOVE coverPhotoId SET updatedAt = :now',
      ExpressionAttributeValues: { ':now': new Date().toISOString() },
      ConditionExpression: 'attribute_exists(pk)',
    }),
  );
}

/**
 * The photoCount bump as a bare command shape, so `attachPhoto` and `detachPhoto`
 * can put the same guarded expression inside their transactions rather than
 * restating it. The condition is what makes a membership change fail cleanly when
 * the folder is deleted mid-flight.
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
 * Takes the folder's shares and its memberships with it — never a photograph.
 *
 * Both cascades exist for the same reason: a share hangs off `SHARE#<tokenHash>`
 * and a membership off `PHOTO#<photoId>`, each with only a gsi1 pointer back at
 * the folder, so dropping the META item alone leaves rows that name a folder that
 * is gone. Cascading here rather than in the route so no later caller can delete a
 * folder and forget.
 *
 * This is what used to need the orphan roll. A folder holds pointers, not images,
 * so deleting one now removes pointers — the photos stay in the library, reachable
 * from "All photos" and from any other roll they are in.
 *
 * ponytail: serial deletes, one round trip each. A 200-frame roll is ~2s inside a
 * 15s budget; switch to BatchWriteItem in 25s if rolls get much larger.
 */
export async function deleteFolder(folderId: string): Promise<void> {
  for (const share of await listSharesForFolder(folderId)) {
    await deleteShare(share.tokenHash);
  }

  for (const membership of await listFolderMemberships(folderId)) {
    await ddb.send(
      new DeleteCommand({
        TableName: TABLE,
        Key: { pk: photoPk(membership.photoId), sk: folderPk(folderId) },
      }),
    );
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
        pk: photoPk(photo.photoId),
        sk: 'META',
        gsi1pk: LIBRARY_PK,
        gsi1sk: `${photo.uploadedAt}#${photo.photoId}`,
        ...photo,
      },
    }),
  );
}

/**
 * A point read at last. This was a filtered query across a folder partition for as
 * long as `pk` carried the folder — the documented "first thing that stops
 * scaling". The photo id is the partition key now, so it costs one read unit
 * whatever the library is doing.
 */
export async function getPhoto(photoId: string): Promise<Photo | null> {
  const res = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { pk: photoPk(photoId), sk: 'META' } }),
  );
  return (res.Item as Photo) ?? null;
}

/** Pages a gsi1 partition in full, newest first. */
async function queryGsi1(pk: string, skPrefix?: string): Promise<unknown[]> {
  const items: unknown[] = [];
  let cursor: Record<string, unknown> | undefined;

  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        IndexName: 'gsi1',
        KeyConditionExpression: skPrefix
          ? 'gsi1pk = :pk AND begins_with(gsi1sk, :prefix)'
          : 'gsi1pk = :pk',
        ExpressionAttributeValues: {
          ':pk': pk,
          ...(skPrefix ? { ':prefix': skPrefix } : {}),
        },
        ExclusiveStartKey: cursor,
        ScanIndexForward: false,
      }),
    );
    items.push(...(res.Items ?? []));
    cursor = res.LastEvaluatedKey;
  } while (cursor);

  return items;
}

/** Every photo, in no folder in particular — what "All photos" renders. */
export const listLibrary = () => queryGsi1(LIBRARY_PK) as Promise<Photo[]>;

/** The memberships of one folder. Ordered, but they carry no photo detail. */
export const listFolderMemberships = (folderId: string) =>
  queryGsi1(folderPk(folderId), 'PHOTO#') as Promise<Membership[]>;

/** The folders one photo is in — what a delete has to unpick. */
export async function listPhotoMemberships(photoId: string): Promise<Membership[]> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': photoPk(photoId), ':prefix': 'FOLDER#' },
    }),
  );
  return (res.Items ?? []) as Membership[];
}

/**
 * Reads many photos by id. `BatchGetItem` caps at 100 keys and may hand some back
 * in `UnprocessedKeys` under throttling, so both are handled here rather than at
 * each call site. Order is not preserved — callers sort by takenAt anyway.
 */
async function batchGetPhotos(photoIds: string[]): Promise<Photo[]> {
  const found: Photo[] = [];

  for (let i = 0; i < photoIds.length; i += 100) {
    let keys = photoIds
      .slice(i, i + 100)
      .map((photoId) => ({ pk: photoPk(photoId), sk: 'META' }));

    while (keys.length) {
      const res = await ddb.send(
        new BatchGetCommand({ RequestItems: { [TABLE]: { Keys: keys } } }),
      );
      found.push(...((res.Responses?.[TABLE] ?? []) as Photo[]));
      keys = (res.UnprocessedKeys?.[TABLE]?.Keys ?? []) as typeof keys;
    }
  }

  return found;
}

/**
 * One folder's photos: its memberships, then the photo records they point at.
 *
 * Two round trips where it used to be one, because the photo no longer lives in
 * the folder's partition. The alternative — copying photo fields onto every
 * membership — would mean every EXIF correction from derive fanning out to each
 * roll the frame is in, which is the trade that goes wrong later.
 *
 * A membership whose photo has been deleted returns nothing from the BatchGet and
 * simply drops out; `deletePhoto` unpicks memberships first, so that is a
 * mid-flight read rather than a lasting state.
 */
export async function listPhotos(folderId: string): Promise<Photo[]> {
  const memberships = await listFolderMemberships(folderId);
  if (!memberships.length) return [];
  return batchGetPhotos(memberships.map((m) => m.photoId));
}

/**
 * Returns false when the record is no longer there — deleted while the caller was
 * working. (It can no longer be "moved": nothing about a photo's key depends on a
 * folder any more.)
 *
 * The condition is the whole point. UpdateItem *upserts*, and every caller here
 * holds an item it read earlier: derive reads the photo, then spends seconds
 * decoding a RAF. Delete the frame in that window and an unguarded update
 * recreates the row from its key plus the patch — no `photoId`, no `basename`.
 * `listLibrary` returns it because the gsi1 projection still matches, and the grid
 * renders `/f/undefined/thumb.webp`. `updateFolder` has always carried this; the
 * photo version did not.
 */
export async function updatePhoto(
  photoId: string,
  patch: Partial<Photo>,
): Promise<boolean> {
  if (!hasPatch(patch)) return true;

  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { pk: photoPk(photoId), sk: 'META' },
        ...setExpression(patch),
        ConditionExpression: 'attribute_exists(pk)',
      }),
    );
    return true;
  } catch (err) {
    if ((err as Error).name !== 'ConditionalCheckFailedException') throw err;
    console.warn('Photo record vanished before its update landed', {
      photoId,
      patch: Object.keys(patch),
    });
    return false;
  }
}

// ----------------------------------------------------------------- memberships

/**
 * Was the transaction cancelled *only* because the guarded item already existed
 * (or already didn't)?
 *
 * `TransactWriteItems` reports per-item outcomes in `CancellationReasons`,
 * positionally, and throws one aggregate error rather than distinguishing them.
 * Attach and detach each guard two items: the membership, whose condition failing
 * means the caller asked for a state that already holds, and the folder, whose
 * condition failing means it was deleted underneath us. Only the first is a no-op.
 */
function isMembershipNoop(err: unknown): boolean {
  const reasons = (err as { CancellationReasons?: Array<{ Code?: string }> })
    .CancellationReasons;
  if ((err as Error).name !== 'TransactionCanceledException' || !reasons) return false;
  return (
    reasons[0]?.Code === 'ConditionalCheckFailed' &&
    reasons.slice(1).every((r) => r.Code === 'None')
  );
}

/**
 * Puts one photo in one folder. Returns false if it was already there.
 *
 * Atomic with the count, so no failure can leave a roll claiming a number its
 * membership list disagrees with. The `attribute_not_exists` guard is what makes
 * a repeated attach idempotent rather than a double count — worth having because
 * the admin can select overlapping sets and press Add twice, and because a photo
 * being in a roll is the whole point of the model now.
 */
export async function attachPhoto(
  folderId: string,
  photo: Photo,
): Promise<boolean> {
  const membership: Membership = {
    photoId: photo.photoId,
    folderId,
    uploadedAt: photo.uploadedAt,
  };

  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: TABLE,
              Item: {
                pk: photoPk(photo.photoId),
                sk: folderPk(folderId),
                gsi1pk: folderPk(folderId),
                gsi1sk: membershipGsi1sk(photo.uploadedAt, photo.photoId),
                ...membership,
              },
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          },
          { Update: photoCountUpdate(folderId, 1) },
        ],
      }),
    );
    return true;
  } catch (err) {
    if (!isMembershipNoop(err)) throw err;
    return false;
  }
}

/**
 * Takes one photo out of one folder. Returns false if it was not in it.
 *
 * Never touches the photo or its bytes — that is the entire difference from the
 * move this replaces, and why it needs no S3 work, no ordering rule and no batch
 * cap. The cover is dropped in the same transaction when it named this frame, or
 * the roll card goes on advertising a photo it no longer contains.
 */
export async function detachPhoto(folder: Folder, photoId: string): Promise<boolean> {
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Delete: {
              TableName: TABLE,
              Key: { pk: photoPk(photoId), sk: folderPk(folder.folderId) },
              ConditionExpression: 'attribute_exists(pk)',
            },
          },
          {
            Update: photoCountUpdate(
              folder.folderId,
              -1,
              folder.coverPhotoId === photoId ? ' REMOVE coverPhotoId' : '',
            ),
          },
        ],
      }),
    );
    return true;
  } catch (err) {
    if (!isMembershipNoop(err)) throw err;
    return false;
  }
}

/**
 * Destroys the photograph itself: every membership first, then the record.
 *
 * Memberships lead so that no folder is left listing a photo that has stopped
 * existing — `listPhotos` would BatchGet a hole. Each detach is its own
 * transaction because they span different folders and DynamoDB caps a transaction
 * at 100 items; a photo in a handful of rolls makes this a handful of round trips.
 */
export async function deletePhoto(photoId: string): Promise<void> {
  for (const membership of await listPhotoMemberships(photoId)) {
    const folder = await getFolder(membership.folderId);
    if (folder) await detachPhoto(folder, photoId);
  }

  await ddb.send(
    new DeleteCommand({ TableName: TABLE, Key: { pk: photoPk(photoId), sk: 'META' } }),
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
