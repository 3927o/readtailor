import { createHash } from 'node:crypto';
import { link, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  NotFound,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

export type StoredObject = {
  key: string;
  contentType?: string;
  size?: number;
  etag?: string;
};

export interface ObjectStorage {
  put(key: string, body: Uint8Array, contentType?: string): Promise<StoredObject>;
  putIfAbsent(
    key: string,
    body: Uint8Array,
    contentType?: string,
  ): Promise<{ object: StoredObject; created: boolean }>;
  get(key: string): Promise<Uint8Array>;
  head(key: string): Promise<StoredObject | undefined>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<StoredObject[]>;
}

export class ObjectNotFoundError extends Error {
  constructor(readonly key: string) {
    super(`object not found: ${key}`);
    this.name = 'ObjectNotFoundError';
  }
}

function normalizeKey(key: string): string {
  const normalized = key.replaceAll('\\', '/').replace(/^\/+/, '');
  if (
    !normalized ||
    normalized.split('/').some((part) => part === '.' || part === '..' || part === '')
  ) {
    throw new Error(`invalid object key: ${key}`);
  }
  return normalized;
}

async function collectBody(body: AsyncIterable<Uint8Array> | undefined): Promise<Uint8Array> {
  if (!body) {
    return new Uint8Array();
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of body) {
    chunks.push(chunk);
    length += chunk.byteLength;
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export class FileSystemObjectStorage implements ObjectStorage {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private pathFor(key: string): string {
    const path = resolve(this.root, normalizeKey(key));
    if (path !== this.root && !path.startsWith(`${this.root}${sep}`)) {
      throw new Error(`object key escapes storage root: ${key}`);
    }
    return path;
  }

  async put(key: string, body: Uint8Array, contentType?: string): Promise<StoredObject> {
    const normalized = normalizeKey(key);
    const path = this.pathFor(normalized);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
    return {
      key: normalized,
      size: body.byteLength,
      etag: createHash('sha256').update(body).digest('hex'),
      ...(contentType ? { contentType } : {}),
    };
  }

  async putIfAbsent(
    key: string,
    body: Uint8Array,
    contentType?: string,
  ): Promise<{ object: StoredObject; created: boolean }> {
    const normalized = normalizeKey(key);
    const path = this.pathFor(normalized);
    await mkdir(dirname(path), { recursive: true });
    const temporaryPath = `${path}.tmp-${crypto.randomUUID()}`;
    await writeFile(temporaryPath, body, { flag: 'wx' });
    try {
      await link(temporaryPath, path);
      return {
        created: true,
        object: {
          key: normalized,
          size: body.byteLength,
          etag: createHash('sha256').update(body).digest('hex'),
          ...(contentType ? { contentType } : {}),
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
      const existing = await this.head(normalized);
      if (!existing) {
        throw new Error(`object appeared concurrently but cannot be read: ${normalized}`);
      }
      return { object: existing, created: false };
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  async get(key: string): Promise<Uint8Array> {
    const normalized = normalizeKey(key);
    try {
      return await readFile(this.pathFor(normalized));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ObjectNotFoundError(normalized);
      }
      throw error;
    }
  }

  async head(key: string): Promise<StoredObject | undefined> {
    const normalized = normalizeKey(key);
    try {
      const info = await stat(this.pathFor(normalized));
      return info.isFile() ? { key: normalized, size: info.size } : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(normalizeKey(key)), { force: true });
  }

  async list(prefix: string): Promise<StoredObject[]> {
    const normalizedPrefix = prefix ? normalizeKey(prefix) : '';
    const objects: StoredObject[] = [];

    const visit = async (directory: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return;
        }
        throw error;
      }
      await Promise.all(
        entries.map(async (entry) => {
          const path = resolve(directory, entry.name);
          if (entry.isDirectory()) {
            await visit(path);
          } else if (entry.isFile()) {
            const info = await stat(path);
            const key = relative(this.root, path).split(sep).join('/');
            if (!normalizedPrefix || key.startsWith(normalizedPrefix)) {
              objects.push({ key, size: info.size });
            }
          }
        }),
      );
    };

    await visit(this.root);
    return objects.sort((a, b) => a.key.localeCompare(b.key));
  }
}

export class S3ObjectStorage implements ObjectStorage {
  private readonly client: S3Client;

  constructor(
    private readonly bucket: string,
    options: {
      endpoint?: string | undefined;
      region: string;
      accessKeyId?: string | undefined;
      secretAccessKey?: string | undefined;
      forcePathStyle?: boolean | undefined;
    },
  ) {
    const credentials =
      options.accessKeyId && options.secretAccessKey
        ? { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey }
        : undefined;
    this.client = new S3Client({
      region: options.region,
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      ...(credentials ? { credentials } : {}),
      ...(options.forcePathStyle !== undefined ? { forcePathStyle: options.forcePathStyle } : {}),
    });
  }

  async put(key: string, body: Uint8Array, contentType?: string): Promise<StoredObject> {
    const normalized = normalizeKey(key);
    const result = await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: normalized,
        Body: body,
        ...(contentType ? { ContentType: contentType } : {}),
      }),
    );
    return {
      key: normalized,
      size: body.byteLength,
      ...(contentType ? { contentType } : {}),
      ...(result.ETag ? { etag: result.ETag.replaceAll('"', '') } : {}),
    };
  }

  async putIfAbsent(
    key: string,
    body: Uint8Array,
    contentType?: string,
  ): Promise<{ object: StoredObject; created: boolean }> {
    const normalized = normalizeKey(key);
    try {
      const result = await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: normalized,
          Body: body,
          IfNoneMatch: '*',
          ...(contentType ? { ContentType: contentType } : {}),
        }),
      );
      return {
        created: true,
        object: {
          key: normalized,
          size: body.byteLength,
          ...(contentType ? { contentType } : {}),
          ...(result.ETag ? { etag: result.ETag.replaceAll('"', '') } : {}),
        },
      };
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status !== 409 && status !== 412) {
        throw error;
      }
      const existing = await this.head(normalized);
      if (!existing) {
        throw new Error(`object precondition failed but object is not readable: ${normalized}`);
      }
      return { object: existing, created: false };
    }
  }

  async get(key: string): Promise<Uint8Array> {
    const normalized = normalizeKey(key);
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: normalized }),
      );
      return collectBody(result.Body as AsyncIterable<Uint8Array> | undefined);
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (
        error instanceof NoSuchKey ||
        error instanceof NotFound ||
        (error as { name?: string }).name === 'NoSuchKey' ||
        status === 404
      ) {
        throw new ObjectNotFoundError(normalized);
      }
      throw error;
    }
  }

  async head(key: string): Promise<StoredObject | undefined> {
    const normalized = normalizeKey(key);
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: normalized }),
      );
      return {
        key: normalized,
        ...(result.ContentLength !== undefined ? { size: result.ContentLength } : {}),
        ...(result.ContentType ? { contentType: result.ContentType } : {}),
        ...(result.ETag ? { etag: result.ETag.replaceAll('"', '') } : {}),
      };
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (error instanceof NotFound || status === 404) {
        return undefined;
      }
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: normalizeKey(key) }),
    );
  }

  async list(prefix: string): Promise<StoredObject[]> {
    const normalizedPrefix = prefix ? normalizeKey(prefix) : '';
    const objects: StoredObject[] = [];
    let continuationToken: string | undefined;
    do {
      const result = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: normalizedPrefix,
          ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
        }),
      );
      for (const object of result.Contents ?? []) {
        if (object.Key) {
          objects.push({
            key: object.Key,
            ...(object.Size !== undefined ? { size: object.Size } : {}),
            ...(object.ETag ? { etag: object.ETag.replaceAll('"', '') } : {}),
          });
        }
      }
      continuationToken = result.NextContinuationToken;
    } while (continuationToken);
    return objects;
  }
}

export function createObjectStorage(config: {
  localRoot?: string | undefined;
  bucket?: string | undefined;
  endpoint?: string | undefined;
  region?: string | undefined;
  accessKeyId?: string | undefined;
  secretAccessKey?: string | undefined;
  forcePathStyle?: boolean | undefined;
}): ObjectStorage | undefined {
  if (config.localRoot && config.bucket) {
    throw new Error('configure either OBJECT_STORAGE_LOCAL_ROOT or OBJECT_STORAGE_BUCKET, not both');
  }
  if (Boolean(config.accessKeyId) !== Boolean(config.secretAccessKey)) {
    throw new Error('object storage access key id and secret access key must be configured together');
  }
  if (config.localRoot) {
    return new FileSystemObjectStorage(config.localRoot);
  }
  if (!config.bucket) {
    return undefined;
  }
  return new S3ObjectStorage(config.bucket, {
    region: config.region ?? (config.endpoint ? 'auto' : 'us-east-1'),
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    ...(config.accessKeyId ? { accessKeyId: config.accessKeyId } : {}),
    ...(config.secretAccessKey ? { secretAccessKey: config.secretAccessKey } : {}),
    forcePathStyle: config.forcePathStyle ?? Boolean(config.endpoint),
  });
}
