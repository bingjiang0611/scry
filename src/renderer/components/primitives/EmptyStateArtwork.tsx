import './empty-state-artwork.css'

type Scene = 'conversation' | 'prompt-library' | 'locked-file'

// These previews describe the structure of the real pane, never its contents.
export function EmptyStateArtwork({ scene }: { scene: Scene }) {
  return <svg className="empty-state-artwork" viewBox="0 0 120 90" aria-hidden="true" focusable="false">
    {scene === 'conversation' ? <>
      <rect className="empty-art-card" x="42" y="15" width="61" height="22" rx="10" />
      <rect className="empty-art-title" x="54" y="23" width="35" height="5" rx="2.5" />
      <rect className="empty-art-card" x="17" y="43" width="74" height="31" rx="10" />
      <rect className="empty-art-title" x="27" y="51" width="37" height="5" rx="2.5" />
      <rect className="empty-art-bar" x="27" y="61" width="49" height="4" rx="2" />
    </> : scene === 'prompt-library' ? <>
      <rect className="empty-art-card" x="15" y="17" width="31" height="55" rx="10" />
      <rect className="empty-art-title" x="23" y="26" width="15" height="5" rx="2.5" />
      <rect className="empty-art-slot" x="22" y="36" width="17" height="12" rx="4" />
      <rect className="empty-art-bar" x="23" y="54" width="13" height="4" rx="2" />
      <rect className="empty-art-card" x="50" y="17" width="55" height="55" rx="10" />
      <rect className="empty-art-title" x="59" y="29" width="26" height="5" rx="2.5" />
      <rect className="empty-art-bar" x="59" y="41" width="35" height="4" rx="2" />
      <rect className="empty-art-bar" x="59" y="49" width="23" height="4" rx="2" />
      <circle className="empty-art-accent" cx="94" cy="60" r="6" />
      <path className="empty-art-accent-mark" d="M94 57v6m-3-3h6" />
    </> : <>
      <rect className="empty-art-card" x="24" y="15" width="62" height="59" rx="10" />
      <rect className="empty-art-title" x="35" y="25" width="31" height="5" rx="2.5" />
      <rect className="empty-art-slot" x="35" y="37" width="39" height="24" rx="5" />
      <rect className="empty-art-card" x="74" y="44" width="30" height="30" rx="10" />
      <path className="empty-art-line" d="M86 58v-3a3 3 0 0 1 6 0v3m-7 0h8v7h-8z" />
    </>}
  </svg>
}
