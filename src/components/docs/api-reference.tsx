'use client'

import Script from 'next/script'
import { useEffect, useRef, useState } from 'react'

declare global {
  interface Window {
    Scalar?: {
      createApiReference: (element: HTMLElement, configuration: Record<string, unknown>) => {
        destroy: () => void
      }
    }
  }
}

const configuration = {
  url: '/api/docs',
  theme: 'kepler',
  darkMode: true,
  hideModels: false,
  hideDownloadButton: false,
  defaultHttpClient: {
    targetKey: 'shell',
    clientKey: 'curl',
  },
  metaData: {
    title: 'Mission Control API Docs',
  },
}

export function ApiReference() {
  const containerRef = useRef<HTMLDivElement>(null)
  const instanceRef = useRef<{ destroy: () => void } | null>(null)
  const [scriptLoaded, setScriptLoaded] = useState(false)

  useEffect(() => {
    if (!scriptLoaded || !containerRef.current || !window.Scalar || instanceRef.current) return
    instanceRef.current = window.Scalar.createApiReference(containerRef.current, configuration)
    return () => {
      instanceRef.current?.destroy()
      instanceRef.current = null
    }
  }, [scriptLoaded])

  return (
    <>
      <Script
        src="/vendor/scalar-api-reference.js"
        strategy="afterInteractive"
        onLoad={() => setScriptLoaded(true)}
      />
      <div ref={containerRef} className="h-full" />
    </>
  )
}
