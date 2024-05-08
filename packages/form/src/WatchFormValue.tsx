import { useAtomValue } from "einfach-state";
import { useGetFormInstance } from "./useGetFormInstance";
import { valuesAtom } from "./state";

export function WatchFormValue() {
  const { store } = useGetFormInstance();
  const values = useAtomValue(valuesAtom, { store });
  // eslint-disable-next-line no-console
  console.info(`表单所有数据`, values);
  return <></>;
}
