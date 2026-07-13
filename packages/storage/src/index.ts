export type StoredObject = {
  key: string;
  contentType?: string;
  size?: number;
  etag?: string;
};

export interface ObjectStorage {
  put(key: string, body: Uint8Array, contentType?: string): Promise<StoredObject>;
  get(key: string): Promise<Uint8Array>;
  head(key: string): Promise<StoredObject | undefined>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<StoredObject[]>;
}
