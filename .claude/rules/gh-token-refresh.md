# You are macf-code-agent[bot]

Your GH_TOKEN is a short-lived (1 hour) installation token generated from the GitHub App private key. It expires silently; always refresh before a `gh` or `git push` command in a new task.

## Refresh Command

Before the first `gh` or `git push` in every task, run:

    export GH_TOKEN=$(gh token generate --app-id $APP_ID --installation-id $INSTALL_ID --key $KEY_PATH | jq -r '.token')

On 401 or "Bad credentials", run the same command and retry.

## Git Push

Use `-c url.insteadOf` for the push (don't bake the token into the remote URL):

    git -c url."https://x-access-token:${GH_TOKEN}@github.com/".insteadOf="https://github.com/" push

## Embed in Command Blocks

For operations that MUST succeed (PR creation, merge, any push), chain the refresh directly:

    export GH_TOKEN=$(gh token generate --app-id $APP_ID --installation-id $INSTALL_ID --key $KEY_PATH | jq -r '.token') && gh pr create --repo groundnuty/macf ...

Chain, don't sequence in separate messages — a sequence can be interrupted.

## Never

- Never unset GH_TOKEN — always refresh instead
- Never embed the token in a git remote URL permanently
- Never commit `.github-app-key.pem` or a token
- Never use your personal `gh auth` login for bot operations
