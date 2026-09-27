#!/usr/bin/env bash
#
# Grants or revokes the ADMIN role on a local user.
#
#   pnpm user:set-role <clerk-user-id> ADMIN
#   pnpm user:set-role <clerk-user-id> USER
#
# `UserRole` has no write path in the API by design: there is deliberately no
# endpoint that can change a role, so promotion cannot be done over HTTP. This
# script is the supported way to do it against a local database.
#
# It uses `prisma db execute`, which takes raw SQL, so the Clerk user ID is
# validated against a strict pattern before it reaches the query.

set -euo pipefail

CLERK_ID="${1:-}"
ROLE="${2:-}"

if [[ ! "$CLERK_ID" =~ ^user_[A-Za-z0-9]+$ ]]; then
  echo "error: first argument must be a Clerk user ID like user_2abc123" >&2
  echo "       got: ${CLERK_ID:-<empty>}" >&2
  exit 1
fi

if [[ "$ROLE" != "ADMIN" && "$ROLE" != "USER" ]]; then
  echo "error: second argument must be ADMIN or USER" >&2
  echo "       got: ${ROLE:-<empty>}" >&2
  exit 1
fi

# The ID is already constrained to [A-Za-z0-9_] by the check above, so
# interpolating it cannot introduce SQL syntax.
SQL="UPDATE \"User\" SET role = '${ROLE}' WHERE id = '${CLERK_ID}';"

echo "Setting role=${ROLE} for ${CLERK_ID}"

printf '%s\n' "$SQL" | pnpm exec prisma db execute --stdin

cat <<'NOTE'

NOTE: this reports success even when no row matched. To confirm, query the user:

  pnpm prisma studio
NOTE
