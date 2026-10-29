# Observed macOS reference locks

Frozen dependency inputs from the October 19, 2026 workbench acceptance run.

`mirin.bun.lock` pairs with `../mirin.package.json`. Copy both to a new private
installation and name them `bun.lock` and `package.json`. Use Bun (version redacted) with
`install --frozen-lockfile --ignore-scripts --linker=hoisted --backend=copyfile`.
The linker/backend are explicit measurement-profile choices, not upstream defaults.

`butter-source.bun.lock` pairs with `../butter.package.json` only after its
`butterframework` dependency is explicitly changed to
`file:butterframework-1.6.3.tgz`. The registry version was unavailable. Build the
local tarball with `bun pm pack --ignore-scripts` from the clean source commit
`a735ddf2eac8f4fe4a98370fc4ccf4373db797d9`, then perform a frozen installation.
Keep this source profile separate from default registry installation, and record
any generated tarball digest differences rather than changing the accepted pin.

Butter's upstream helper must also be prepared from its shipped source before the
compiled path works. The initial failure and separately measured helper build are
retained. These locks alone do not qualify browser execution or signing.

See `docs/m2-macos-acceptance.md` for hashes, exact runtimes, commands and limitations.
No package from either profile is a Bunly runtime dependency.
