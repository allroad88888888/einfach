
import type { FC, ReactNode } from 'react'
import { ProviderCacheContext, useCreateCache } from './ProviderCache'

export const CacheProvider: FC<{
    children: ReactNode
}> = ({ children }) => {
    const cache = useCreateCache()
    return (
        <ProviderCacheContext.Provider value={cache}>
            {children}
        </ProviderCacheContext.Provider>
    )
}

