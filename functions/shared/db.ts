import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
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

// --------------------------------------------------------------------- folders

export async function putFolder(folder: Folder): Promise<void> {
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
    }),
  );
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
  patch: Partial<Pick<Folder, 'name' | 'coverPhotoId' | 'rawVisibleDefault'>>,
): Promise<void> {
  const fields = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (fields.length === 0) return;

  const names: Record<string, string> = { '#updatedAt': 'updatedAt' };
  const values: Record<string, unknown> = { ':updatedAt': new Date().toISOString() };
  const sets = ['#updatedAt = :updatedAt'];

  for (const [key, value] of fields) {
    names[`#${key}`] = key;
    values[`:${key}`] = value;
    sets.push(`#${key} = :${key}`);
  }

  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { pk: folderPk(folderId), sk: 'META' },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ConditionExpression: 'attribute_exists(pk)',
    }),
  );
}

export async function bumpPhotoCount(folderId: string, delta: number): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { pk: folderPk(folderId), sk: 'META' },
      UpdateExpression: 'SET photoCount = if_not_exists(photoCount, :zero) + :delta',
      ExpressionAttributeValues: { ':zero': 0, ':delta': delta },
      ConditionExpression: 'attribute_exists(pk)',
    }),
  );
}

export async function deleteFolder(folderId: string): Promise<void> {
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
  const fields = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (fields.length === 0) return;

  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const sets: string[] = [];

  for (const [key, value] of fields) {
    names[`#${key}`] = key;
    values[`:${key}`] = value;
    sets.push(`#${key} = :${key}`);
  }

  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { pk: folderPk(photo.folderId), sk: photoSk(photo.uploadedAt, photo.photoId) },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
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
