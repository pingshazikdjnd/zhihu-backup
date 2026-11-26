#!/usr/bin/env sh
set -eu

if [ "$#" -lt 2 ]; then
  echo "::error::Usage: publish-release.sh <tag> <notes-file> [asset...]" >&2
  exit 1
fi

tag=$1
notes=$2
shift 2

if [ ! -f "$notes" ] || ! grep -q '[^[:space:]]' "$notes"; then
  echo "::error::Release notes file is missing or blank: $notes" >&2
  exit 1
fi

lookup_state() {
  if ! raw=$(gh api --paginate "repos/{owner}/{repo}/releases" --jq ".[] | select(.tag_name == \"$tag\") | .draft"); then
    echo "::error::Failed to query GitHub releases for $tag" >&2
    return 1
  fi
  case "$raw" in
    *false*) echo "published" ;;
    *true*) echo "draft" ;;
    *) echo "none" ;;
  esac
}

for attempt in 1 2; do
  state=$(lookup_state)
  case "$state" in
    published)
      echo "Release $tag is already published; skipping."
      exit 0
      ;;
    draft)
      echo "Removing leftover draft release for $tag."
      gh release delete "$tag" --yes
      ;;
  esac

  if gh release create "$tag" "$@" --verify-tag --title "$tag" --notes-file "$notes"; then
    echo "Published release $tag."
    exit 0
  fi
  echo "Release attempt $attempt for $tag failed." >&2
done

echo "::error::Could not publish release $tag after 2 attempts." >&2
exit 1
