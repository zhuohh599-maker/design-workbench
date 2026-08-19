import type { FC, SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement>

export const PaletteIcon: FC<IconProps> = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" {...props}>
    <circle cx="12" cy="12" r="9" />
    <circle cx="9" cy="10" r="1.5" fill="currentColor" stroke="none" />
    <circle cx="15" cy="10" r="1.5" fill="currentColor" stroke="none" />
    <circle cx="12" cy="15" r="1.5" fill="currentColor" stroke="none" />
  </svg>
)

export const ResizeIcon: FC<IconProps> = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" />
  </svg>
)

export const ConvertIcon: FC<IconProps> = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M4 8h12M4 8l3-3M4 8l3 3M20 16H8M20 16l-3 3M20 16l-3-3" />
  </svg>
)

export const CompressIcon: FC<IconProps> = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M8 8L4 4M4 4h4M4 4v4M16 16l4 4M20 20h-4M20 20v-4" />
  </svg>
)

export const MattingIcon: FC<IconProps> = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M12 2l2.5 5.5L20 10l-5.5 2.5L12 18l-2.5-5.5L4 10l5.5-2.5L12 2z" />
    <path d="M18 16l4 4" />
  </svg>
)

export const AnimakerIcon: FC<IconProps> = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" {...props}>
    <rect x="4" y="8" width="10" height="10" rx="1.5" />
    <rect x="10" y="4" width="10" height="10" rx="1.5" />
  </svg>
)

export const ChromakeyIcon: FC<IconProps> = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" {...props}>
    <rect x="2" y="7" width="12" height="10" rx="1.5" />
    <path d="M16 9l6 3-6 3z" />
  </svg>
)

export const RoundedIcon: FC<IconProps> = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" {...props}>
    <rect x="3" y="3" width="18" height="18" rx="6" />
  </svg>
)

export const VectorizeIcon: FC<IconProps> = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M3 18C7 6 17 6 21 18" />
    <circle cx="3" cy="18" r="1.6" fill="currentColor" stroke="none" />
    <circle cx="21" cy="18" r="1.6" fill="currentColor" stroke="none" />
  </svg>
)

