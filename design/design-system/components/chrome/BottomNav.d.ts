import React from 'react';

export interface BottomNavItem {
  value: string;
  label: React.ReactNode;
}

export interface BottomNavProps extends Omit<React.HTMLAttributes<HTMLElement>, 'onChange'> {
  /** @default 书架 / 发现 / 我的 */
  items?: BottomNavItem[];
  /** Selected item value. */
  value?: string;
  onChange?: (value: string) => void;
  /** position:fixed at the viewport bottom. @default true */
  fixed?: boolean;
}

/**
 * Frosted word-label bottom navigation (no icons; green dot marks the active tab).
 */
export function BottomNav(props: BottomNavProps): JSX.Element;
