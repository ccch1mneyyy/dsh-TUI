# Standalone packager

This private project pins the build tool and its dependency graph separately from the runtime seed. Its node_modules is never included in runtime.tar.gz. The bundle builder installs this project's committed lockfile with scripts disabled, verifies the patched prelude, and invokes the installed pkg binary directly.

pkg 6.22.0 aliases fs.realpathSync.native to its legacy realpath wrapper. Node's legacy implementation resolves symlinks but preserves ordinary Windows 8.3 path components. That prevents the standalone launcher's canonicalWindowsPath from expanding those components before a libuv directory watcher sees long-name events.

The local patch preserves the original native function for physical paths. Paths inside pkg's snapshot retain pkg's existing virtual-filesystem behavior. It does not disable watchers, alter libuv assertions, invoke an external path-conversion program, or change the runtime seed.

The exact upstream baseline is pkg v6.22.0, commit 8d3d7af9fe9cbb02ec60c78c4c71de343e259c0a, prelude/bootstrap.js. Native Windows packaged verification must also check the child's actual cwd/cache/runtime paths against the test driver's native realpaths. A source-mode fixture alone does not establish packaged behavior.
