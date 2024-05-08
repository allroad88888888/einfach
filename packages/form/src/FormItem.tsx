import type { ReactNode } from 'react';
import React, { cloneElement, isValidElement } from 'react';
import type { NamePath } from './type';
import { useField } from './useField';

export type FormItemProps = {
  label?: React.ReactNode;
  noStyle?: boolean;
  style?: React.CSSProperties;
  className?: string;
  children: ReactNode;
  name: NamePath;
};

export function FormItem(props: FormItemProps) {
  const { noStyle = true, children, name } = props;
  const { value, onChange } = useField(name);

  if (noStyle && isValidElement(children)) {
    return cloneElement(children, {
      ...children.props,
      value,
      onChange,
    });
  }

  return <div>不适合</div>;
}
