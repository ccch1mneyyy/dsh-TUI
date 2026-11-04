{
  description = "dsh-TUI with a pinned DeepSeek Harness runtime";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      packageFor = system:
        let
          pkgs = import nixpkgs { inherit system; };
          nodePlatforms = {
            x86_64-linux = { platform = "linux-x64"; hash = "55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742"; };
            aarch64-linux = { platform = "linux-arm64"; hash = "58c9520501f6ae2b52d5b210444e24b9d0c029a58c5011b797bc1fe7105886f6"; };
            aarch64-darwin = { platform = "darwin-arm64"; hash = "4477b9f78efb77744cf5eb57a0e9594dba66466b38b4e93fa9f35cb907a095a6"; };
          }.${system};
          node = pkgs.stdenvNoCC.mkDerivation {
            pname = "dsh-tui-node";
            version = "24.18.0";
            src = pkgs.fetchurl {
              url = "https://nodejs.org/dist/v24.18.0/node-v24.18.0-${nodePlatforms.platform}.tar.xz";
              sha256 = nodePlatforms.hash;
            };
            nativeBuildInputs = pkgs.lib.optionals pkgs.stdenv.hostPlatform.isLinux [ pkgs.patchelf ];
            dontBuild = true;
            dontStrip = true;
            installPhase = ''
              mkdir -p "$out/bin" "$out/share/licenses/node"
              cp bin/node "$out/bin/node"
              cp LICENSE "$out/share/licenses/node/LICENSE"
            '' + pkgs.lib.optionalString pkgs.stdenv.hostPlatform.isLinux ''
              patchelf --no-sort \
                --set-interpreter ${pkgs.stdenv.cc.bintools.dynamicLinker} \
                --set-rpath ${pkgs.lib.makeLibraryPath [ pkgs.stdenv.cc.cc.lib pkgs.stdenv.cc.cc.libgcc ]} \
                "$out/bin/node"
            '';
          };
          pnpm = pkgs.pnpm_11;
          runtimeSrc = pkgs.runCommand "dsh-tui-runtime-src" { } ''
            mkdir -p "$out"
            cp ${./nix/runtime-package.json} "$out/package.json"
            cp ${./nix/runtime-pnpm-lock.yaml} "$out/pnpm-lock.yaml"
            cp ${./nix/runtime-pnpm-workspace.yaml} "$out/pnpm-workspace.yaml"
          '';
          runtime = pkgs.stdenvNoCC.mkDerivation {
            pname = "dsh-tui-runtime";
            version = "0.17.0-dsh-0.2.1-rc.3";
            src = runtimeSrc;
            nativeBuildInputs = [ node pnpm pkgs.pnpmConfigHook ];
            pnpmDeps = pkgs.fetchPnpmDeps {
              pname = "dsh-tui-runtime-deps";
              version = "0.17.0";
              src = runtimeSrc;
              pnpm = pkgs.pnpm_11;
              pnpmWorkspaces = [ "." ];
              fetcherVersion = 5;
              hash = "sha256-zYHJ7ngS0rwAap428aR1P/QjiUBkA0K+uYZpcWG7pQg=";
            };
            installPhase = ''
              runHook preInstall
              node node_modules/@deepseek-ai/dsh-subprocess-local/scripts/ensure-spawn-helper.mjs
              mkdir -p "$out/lib/dsh-tui"
              cp -a node_modules "$out/lib/dsh-tui/"
              runHook postInstall
            '';
          };
          package = pkgs.stdenvNoCC.mkDerivation {
            pname = "dsh-tui";
            version = "0.17.0";
            nativeBuildInputs = [ pkgs.makeWrapper ];
            dontUnpack = true;
            dontBuild = true;
            installPhase = ''
              runHook preInstall
              mkdir -p "$out/bin" "$out/libexec"
              cp ${./nix/launch.mjs} "$out/libexec/launch.mjs"
              substituteInPlace "$out/libexec/launch.mjs" \
                --replace-fail '@runtime@' '${runtime}' \
                --replace-fail '@node@' '${node}' \
                --replace-fail '@pnpm@' '${pnpm}' \
                --replace-fail '@coreutils@' '${pkgs.coreutils}'
              makeWrapper ${node}/bin/node "$out/bin/dsh-tui" --add-flags "$out/libexec/launch.mjs"
              ln -s dsh-tui "$out/bin/dst"
              ln -s ${runtime}/lib/dsh-tui/node_modules/@deepseek-ai/dsh/lib/bin.js "$out/bin/dsh"
              runHook postInstall
            '';
            meta = {
              description = "Terminal UI for DeepSeek Harness (bundled DSH 0.2.1-rc.3)";
              homepage = "https://github.com/ccch1mneyyy/dsh-TUI";
              license = pkgs.lib.licenses.mit;
              mainProgram = "dsh-tui";
              platforms = systems;
            };
            passthru = { inherit runtime node pnpm; };
            doInstallCheck = true;
            installCheckPhase = ''
              ${node}/bin/node ${./nix/verify.mjs} "$out" ${runtime} ${pkgs.runtimeShell}
            '';
          };
        in package;
      homeManagerModule = { config, lib, pkgs, ... }:
        let cfg = config.programs.dsh-tui;
        in {
          options.programs.dsh-tui = {
            enable = lib.mkEnableOption "dsh-TUI with bundled DSH";
            package = lib.mkOption {
              type = lib.types.package;
              default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
              defaultText = lib.literalExpression "inputs.dsh-tui.packages.\${pkgs.stdenv.hostPlatform.system}.default";
              description = "The bundled dsh-TUI package.";
            };
            dshHome = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              example = "\${config.home.homeDirectory}/.dsh";
              description = "Optional DSH home directory.";
            };
          };
          config = lib.mkIf cfg.enable {
            home.packages = [ cfg.package ];
            home.sessionVariables = lib.optionalAttrs (cfg.dshHome != null) { DSH_HOME = cfg.dshHome; };
          };
        };
      nixosModule = { config, lib, pkgs, ... }:
        let cfg = config.programs.dsh-tui;
        in {
          options.programs.dsh-tui = {
            enable = lib.mkEnableOption "dsh-TUI with bundled DSH";
            package = lib.mkOption {
              type = lib.types.package;
              default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
              defaultText = lib.literalExpression "inputs.dsh-tui.packages.\${pkgs.stdenv.hostPlatform.system}.default";
              description = "The bundled dsh-TUI package.";
            };
          };
          config = lib.mkIf cfg.enable { environment.systemPackages = [ cfg.package ]; };
        };
    in {
      packages = forAllSystems (system: {
        default = packageFor system;
        dsh-tui = packageFor system;
      });
      devShells = forAllSystems (system:
        let pkgs = import nixpkgs { inherit system; };
        in { default = pkgs.mkShell { packages = [ pkgs.nodejs-slim_24 pkgs.pnpm_11 ]; }; });
      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = "${self.packages.${system}.default}/bin/dsh-tui";
          meta.description = "dsh-TUI with bundled DeepSeek Harness";
        };
      });
      checks = forAllSystems (system: { runtime = self.packages.${system}.default; });
      homeManagerModules.default = homeManagerModule;
      homeManagerModules.dsh-tui = homeManagerModule;
      nixosModules.default = nixosModule;
      nixosModules.dsh-tui = nixosModule;
    };
}
