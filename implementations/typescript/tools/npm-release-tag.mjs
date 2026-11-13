/** Pre-releases must not replace the stable npm default dist-tag. */
export function npmReleaseTag(version) {
  return version.split('+', 1)[0].includes('-') ? 'next' : 'latest';
}
