
import React from 'react'
import { ProviderCacheContext, useCreateCache } from './ProviderCache'

export const CacheProvider: React.FC<{
    children: React.ReactNode
}> = ({ children }) => {
    const cache = useCreateCache()
    return (
        <ProviderCacheContext.Provider value={cache}>
            {children}
        </ProviderCacheContext.Provider>
    )
}


