{
  lib,
  buildNpmPackage,
  makeWrapper,
  nodejs_22,
}:

buildNpmPackage {
  pname = "agentslave";
  version = "0.1.0";

  src = lib.cleanSourceWith {
    src = ../.;
    filter =
      path: type:
      let
        name = baseNameOf path;
      in
      !(
        name == ".git"
        || name == "node_modules"
        || name == "data"
        || name == "upstream"
        || name == "workspaces"
      );
  };

  npmDepsHash = "sha256-UDOzrR7D+BxGXIKz4+Ar9FPz/DXQuuaHW+Jr8kfUe+s=";
  npmBuildScript = "build";
  nativeBuildInputs = [ makeWrapper ];

  installPhase = ''
    runHook preInstall

    app="$out/lib/agentslave"
    mkdir -p "$app" "$out/bin"
    cp -r apps packages node_modules package.json package-lock.json HARNESS.md "$app/"

    makeWrapper ${nodejs_22}/bin/node "$out/bin/agentslave" \
      --add-flags "$app/apps/orchestrator/dist/index.js"
    makeWrapper ${nodejs_22}/bin/node "$out/bin/agentslave-migrate" \
      --add-flags "$app/apps/orchestrator/dist/migrate.js"
    makeWrapper ${nodejs_22}/bin/node "$out/bin/agentslave-status" \
      --add-flags "$app/apps/orchestrator/dist/status.js"
    makeWrapper ${nodejs_22}/bin/node "$out/bin/agentslave-incus-image" \
      --add-flags "$app/apps/orchestrator/dist/incus-image.js"

    runHook postInstall
  '';

  meta = {
    description = "Slack-to-pull-request agent orchestration service";
    license = lib.licenses.asl20;
    mainProgram = "agentslave";
    platforms = lib.platforms.unix;
  };
}
