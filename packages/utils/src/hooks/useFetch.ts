
import { useCallback, useRef, useState } from 'react';

export function useFetch<T extends (...args: any) => Promise<any>>({
  fetcher,
  auto = true,
  defaultParam,
}: {
  fetcher: T;
  auto?: boolean;
  defaultParam?: Parameters<T>;
}) {
  const [{ data, loading }, setDataAndLoading] = useState<{
    data: ReturnType<T> | null;
    loading: boolean;
  }>({
    data: null,
    loading: auto,
  });

  const run = useCallback(async (...params: Parameters<T>) => {
    if (loading === false) {
      setDataAndLoading({
        data,
        loading: true,
      });
    }

    const res = await fetcher(...params);
    setDataAndLoading({
      data: res,
      loading: false,
    });
  }, [fetcher, setDataAndLoading]);

  const { current } = useRef<{ init: boolean; depDefaultParam: any }>({
    init: false,
    depDefaultParam: defaultParam,
  });

  if (auto === true && (current.init === false || current.depDefaultParam !== defaultParam)) {
    current.init = true;
    current.depDefaultParam = defaultParam;
    if (defaultParam) {
      run(...defaultParam);
    }
    // @ts-ignore
    run();
  }
  return {
    run,
    data,
    loading,
  };
}
