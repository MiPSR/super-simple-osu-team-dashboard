{
  lib,
  stdenv,
  makeWrapper,
  bun,
  cacert,
  # Set after the first build: `nix build .# 2>&1 | grep got:` then paste the hash.
  bunDepsHash ? "sha256-jYg5wQY7MpN0rziB/DtBMl6Tg9KVRuanHilyQiB0dq8=",
}: let
  pname = "osu-team-dashboard";
  version = "0.1.0";

  # Lockfile + workspace manifests only, for the fixed-output `bun install`.
  bunInstallSrc = lib.cleanSourceWith {
    name = "${pname}-bun-install-src";
    src = ./..;
    filter = path: type: let
      base = baseNameOf path;
    in
      if type == "directory"
      then !(builtins.elem base [".git" "node_modules" "data" "result" "result-*"])
      else base == "package.json" || base == "bun.lock";
  };

  # Fixed-output dependency fetch: reproducible node_modules from bun.lock.
  bunDeps = stdenv.mkDerivation {
    name = "${pname}-bun-deps-${version}";
    src = bunInstallSrc;
    nativeBuildInputs = [bun cacert];
    dontConfigure = true;
    dontFixup = true;
    outputHashAlgo = "sha256";
    outputHashMode = "recursive";
    outputHash = bunDepsHash;
    SSL_CERT_FILE = "${cacert}/etc/ssl/certs/ca-bundle.crt";
    NODE_EXTRA_CA_CERTS = "${cacert}/etc/ssl/certs/ca-bundle.crt";

    buildPhase = ''
      runHook preBuild
      export HOME="$TMPDIR"
      export BUN_INSTALL_CACHE_DIR="$TMPDIR/bun-cache"
      bun install --frozen-lockfile --ignore-scripts
      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall
      mkdir -p "$out"
      cp -a node_modules "$out/"
      for d in apps/*/node_modules packages/*/node_modules; do
        if [ -d "$d" ]; then
          mkdir -p "$out/$(dirname "$d")"
          cp -a "$d" "$out/$d"
        fi
      done
      runHook postInstall
    '';
  };

  src = lib.cleanSourceWith {
    name = "${pname}-src";
    src = ./..;
    filter = path: type: let
      base = baseNameOf path;
    in
      if type == "directory"
      then !(builtins.elem base [".git" "node_modules" "data" "dist"])
      else !lib.hasPrefix "result" base && base != ".env" && !lib.hasSuffix ".sqlite" base;
  };
in
  stdenv.mkDerivation {
    inherit pname version src;

    nativeBuildInputs = [bun makeWrapper cacert];

    SSL_CERT_FILE = "${cacert}/etc/ssl/certs/ca-bundle.crt";

    buildPhase = ''
      runHook preBuild
      export HOME="$TMPDIR"
      export BUN_INSTALL_CACHE_DIR="$TMPDIR/bun-cache"

      echo "restoring bun node_modules"
      cp -a "${bunDeps}/node_modules" ./node_modules
      for d in "${bunDeps}"/apps/*/node_modules "${bunDeps}"/packages/*/node_modules; do
        if [ -d "$d" ]; then
          rel="''${d#"${bunDeps}/"}"
          mkdir -p "$(dirname "$rel")"
          rm -rf "$rel"
          cp -a "$d" "$rel"
        fi
      done

      echo "building frontend bundle"
      bun run build
      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall
      appdir="$out/lib/${pname}"
      mkdir -p "$appdir" "$out/bin"

      # The build tree already contains the restored workspace node_modules
      # (relative symlinks preserved by cp).
      cp -r apps packages scripts node_modules package.json tsconfig.json bun.lock "$appdir/"

      makeWrapper "${bun}/bin/bun" "$out/bin/dashboard" \
        --add-flags "run $appdir/scripts/start.ts"

      makeWrapper "${bun}/bin/bun" "$out/bin/dashboard-web" \
        --add-flags "run $appdir/apps/web/src/main.ts"

      makeWrapper "${bun}/bin/bun" "$out/bin/dashboard-collector" \
        --add-flags "run $appdir/apps/collector/src/main.ts"
      runHook postInstall
    '';

    # The app reads its configuration from data/config.toml in the working
    # directory; the SQLite database is created beside it.
    passthru = {
      inherit bunDeps;
    };

    meta = {
      description = "osu! team statistics dashboard — collector, SQLite store and web UI";
      homepage = "https://github.com/kzk/super-simple-osu-team-dashboard";
      license = lib.licenses.agpl3Only;
      platforms = lib.platforms.unix;
      mainProgram = "dashboard";
    };
  }
