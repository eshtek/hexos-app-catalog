#!/usr/bin/env bash
# Opens or refreshes the pull request for one image update in a plan from
# `bun _lib/image_watch.ts check --out <plan>`. Run from the repo root by the image-watch workflow,
# once per update, so one update's failure leaves the others' pull requests to open.
#
# The pull request lives on the update's branch: image-watch/<app>, or image-watch/<app>-major as a
# draft for the next major version. The branch is rebuilt from the base branch each run, so a newer
# tag replaces the one it carried, until a person commits to it: from then on the watcher only
# comments when a newer tag is out. A pull request closed without merging declines its tag: the
# same title is never opened again, and the next newer tag opens a new one.
#
# Usage: _lib/image_watch_pr.sh <plan.json> <id>   (BASE: the branch to target, staging by default)
set -euo pipefail

plan="$1"
id="$2"
base="${BASE:-staging}"

field() { jq -r --arg id "$id" ".updates[] | select(.id == \$id) | .$1" "$plan"; }
branch=$(field branch)
title=$(field title)
file=$(field file)
to=$(field to)
draft=$(field draft)
body=$(mktemp)
field body > "$body"

declined=$(gh pr list --head "$branch" --state closed --json title,mergedAt \
  | jq --arg title "$title" '[.[] | select(.mergedAt == null and .title == $title)] | length')
if [ "$declined" != "0" ]; then
  echo "$title was declined; waiting for a newer tag"
  exit 0
fi

# A person's commits on the branch (a script adapted to a major version, a fix) are never pushed
# over while they're only on it. The watcher's commits carry its git identity as author and as
# committer; any other commit is a person's, a merge from GitHub's Update branch among them.
if git rev-parse --verify --quiet "origin/$branch" > /dev/null; then
  me=$(git config user.email)
  people=$(git log --format='%ae %ce' "origin/$base..origin/$branch" | awk -v me="$me" '$1 != me || $2 != me' | wc -l | tr -d ' ')
  if [ "$people" != "0" ]; then
    open=$(gh pr list --head "$branch" --state open --json number --jq '.[0].number // empty')
    if [ -n "$open" ]; then
      # A script the person left unreadable carries no tag, so the comment still goes out
      carried=$(git show "origin/$branch:$file" 2> /dev/null | jq -r '.app_values.image.tag | split("@")[0]' 2> /dev/null || true)
      if [ "$carried" = "${to%%@*}" ]; then
        echo "#$open has a person's commits and already carries ${to%%@*}"
        exit 0
      fi
      marker="<!-- image-watch: $to -->"
      if gh pr view "$open" --json comments --jq '.comments[].body' | grep -qF -- "$marker"; then
        echo "#$open has a person's commits and was already told about ${to%%@*}"
        exit 0
      fi
      comment=$(mktemp)
      printf '%s\n%s\n' "$marker" "A newer tag is out: \`$to\`. This branch has commits from a person, so the image watcher leaves it as it is. Move the tag here by hand, or close this pull request and the watcher opens a new one for the newest tag." > "$comment"
      gh pr comment "$open" --body-file "$comment" > /dev/null
      echo "Commented on #$open: ${to%%@*} is out"
      exit 0
    fi
    # With no open pull request, the branch is rebuilt only when a closed or merged one keeps its
    # commits (GitHub keeps a pull request's head after the branch moves)
    tip=$(git rev-parse "origin/$branch")
    kept=$(gh pr list --head "$branch" --state all --json headRefOid | jq --arg tip "$tip" '[.[] | select(.headRefOid == $tip)] | length')
    if [ "$kept" = "0" ]; then
      echo "::warning::$branch has commits from a person that no pull request keeps, so it was left as it is"
      exit 0
    fi
  fi
fi

git checkout --quiet -B "$branch" "origin/$base"
bun _lib/image_watch.ts apply "$plan" "$id"
bun _lib/validate.ts > /dev/null
bun _lib/script_bumps.ts "origin/$base" > /dev/null
# The script alone: nothing else the run touched rides along
git add -- "$file"
git commit --quiet -m "$title" -- "$file"

if git rev-parse --verify --quiet "origin/$branch" > /dev/null && git diff --quiet "origin/$branch" HEAD; then
  echo "$branch already carries $title"
else
  git push --quiet --force origin "$branch"
fi

number=$(gh pr list --head "$branch" --state open --json number --jq '.[0].number // empty')
if [ -n "$number" ]; then
  gh pr edit "$number" --title "$title" --body-file "$body" > /dev/null
  echo "Refreshed #$number: $title"
elif [ "$draft" = "true" ]; then
  gh pr create --draft --base "$base" --head "$branch" --title "$title" --body-file "$body"
else
  gh pr create --base "$base" --head "$branch" --title "$title" --body-file "$body"
fi
