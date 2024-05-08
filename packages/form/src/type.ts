
import { Store } from "einfach-state";

export type NamePath = string | number | (string | number)[];

export type FieldData = {
  /**
   * 错误信息
   * @deprecated
   */
  errors?: string[];
  /**
   * 警告信息
   * @deprecated
   */
  warnings?: string[];
  name: NamePath[];
  value: any;
  /**
   * 是否正在校验
   * @deprecated
   */
  validating?: boolean;
  /**
   * 是否被用户操作过
   * @deprecated
   */
  touched?: boolean;
};

export interface FormInstance {
  store: Store;
  setFieldValue: <Value extends unknown = unknown>(name: NamePath, value: Value) => void;
  setFieldsValue: (values: any) => void;
  getFieldValue: <Value extends unknown = unknown>(name: NamePath, value: Value) => Value;
  // getFieldValue: <T extends unknown>(name: NamePath) => T
  // getFieldValue: <T extends unknown>(name: NamePath) => T;
  getFieldsValue: (nameList: true | NamePath[]) => any;
}
