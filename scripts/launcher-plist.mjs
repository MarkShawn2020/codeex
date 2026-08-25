function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function launcherInfoPlist({
  version,
  nodePath,
  projectRoot,
  launcherDist,
}) {
  const launcherDistEntry = launcherDist
    ? `\n  <key>CodeexLauncherDist</key><string>${xmlEscape(launcherDist)}</string>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleDevelopmentRegion</key><string>zh_CN</string>
  <key>CFBundleDisplayName</key><string>Codeex</string>
  <key>CFBundleExecutable</key><string>Codeex</string>
  <key>CFBundleIconFile</key><string>Codeex.icns</string>
  <key>CFBundleIdentifier</key><string>ai.lovstudio.codeex</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Codeex</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${xmlEscape(version)}</string>
  <key>CFBundleVersion</key><string>${xmlEscape(version)}</string>
  <key>CodeexNodePath</key><string>${xmlEscape(nodePath)}</string>
  <key>CodeexProjectRoot</key><string>${xmlEscape(projectRoot)}</string>${launcherDistEntry}
  <key>CodeexRuntimeMode</key><string>local-clone</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
`;
}
