import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { Kicker } from '../components/core/Kicker';
import { importBook } from './api';
import { LibraryChrome } from './LibraryChrome';

export function ImportPage() {
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const upload = useMutation({
    mutationFn: importBook,
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ['user-books'] });
      navigate(`/books/${result.bookId}/processing`, { replace: true });
    },
  });

  const accept = (candidate?: File) => {
    if (!candidate) return;
    setFile(candidate);
    upload.reset();
  };

  return (
    <LibraryChrome>
      <main className="import-page">
        <Kicker>ADD A BOOK · 上传书籍</Kicker>
        <h1>上传一本 EPUB</h1>
        <p className="import-lede">上传后，我们会把它准备成适合在线阅读的版本。你可以先离开，回来时进度还在。</p>

        <input
          ref={input}
          className="visually-hidden"
          type="file"
          accept=".epub,application/epub+zip"
          onChange={(event) => accept(event.target.files?.[0])}
        />
        <button
          className="epub-dropzone"
          data-dragging={dragging}
          type="button"
          onClick={() => input.current?.click()}
          onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            accept(event.dataTransfer.files[0]);
          }}
        >
          <span className="epub-dropzone-title">{file ? file.name : '选择 EPUB 文件'}</span>
          <span className="epub-dropzone-meta">
            {file ? formatBytes(file.size) : '或拖放到此处 · EPUB ONLY'}
          </span>
        </button>

        <div className="import-note">
          首发只收 EPUB，单个文件不超过 100 MB。PDF、扫描件、加密或 DRM 版本暂时无法处理。
        </div>
        {upload.isError ? <div className="form-error" role="alert">{upload.error.message}</div> : null}
        <div className="import-actions">
          <button
            className="button button-primary"
            type="button"
            disabled={!file || upload.isPending}
            onClick={() => file && upload.mutate(file)}
          >
            {upload.isPending ? '正在上传…' : '上传并准备'}
          </button>
          {file ? (
            <button className="text-button" type="button" disabled={upload.isPending} onClick={() => setFile(null)}>重新选择</button>
          ) : null}
        </div>
      </main>
    </LibraryChrome>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
