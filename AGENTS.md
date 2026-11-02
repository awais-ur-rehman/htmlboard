# Notes for agents working on htmlboard

## Publishing a release to npm

The npm token is `NPM_KEY` in `.env` (git ignores it; `.env.example` shows the format). Use it
without reading or printing it: load `.env` into the environment of the command that needs it, and
let npm read the token from there.

1. Start from a clean `main` that is up to date with `origin/main`, and run the tests: `npm test`.
2. Check what goes in the package (no `.env`, no `test/` or `design/`): `npm pack --dry-run`.
3. Bump the version. New features bump the minor version, fixes the patch version:
   `npm version minor` (or `patch`). It commits "x.y.z" and tags `vx.y.z`, like the earlier releases.
4. Publish with a temporary npmrc that names the variable, not the token (the single quotes keep
   `${NPM_KEY}` literal; npm fills it in from the environment):

   ```sh
   tmp=$(mktemp -d)
   printf '//registry.npmjs.org/:_authToken=${NPM_KEY}\n' > "$tmp/npmrc"
   ( set -a; . ./.env; set +a; npm whoami --userconfig "$tmp/npmrc" && npm publish --userconfig "$tmp/npmrc" )
   rm -rf "$tmp"
   ```

   `npm whoami` should print `luizcarlos1405`; then `+ htmlboard@x.y.z` means it was published.
5. Push the commit and its tag: `git push origin main --follow-tags`.
6. Check the release. The registry can take a few minutes to list a new version:
   `npm view htmlboard version --prefer-online`, then `npx -y htmlboard@x.y.z --version` in another folder.
