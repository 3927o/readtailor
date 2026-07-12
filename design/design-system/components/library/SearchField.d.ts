import React from 'react';

export interface SearchFieldProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Controlled value. */
  value?: string;
  /** Input change handler. */
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  /** @default '搜索书名、作者…' */
  placeholder?: string;
  /** Called on Enter. */
  onSubmit?: (e: React.KeyboardEvent) => void;
  /** Extra styles for the inner <input>. */
  inputStyle?: React.CSSProperties;
}

/**
 * Quiet underline search — mono SEARCH label, green focus underline.
 */
export function SearchField(props: SearchFieldProps): JSX.Element;
