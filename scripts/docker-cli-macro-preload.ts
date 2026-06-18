globalThis.MACRO ??= {
  VERSION: process.env.CC_HAHA_VERSION || '999.0.0-local',
  BUILD_TIME: process.env.CC_HAHA_BUILD_TIME || new Date(0).toISOString(),
  PACKAGE_URL: process.env.CC_HAHA_PACKAGE_URL || 'claude-code-local',
  NATIVE_PACKAGE_URL: process.env.CC_HAHA_NATIVE_PACKAGE_URL || 'claude-code-local',
  FEEDBACK_CHANNEL: process.env.CC_HAHA_FEEDBACK_CHANNEL || 'the project issue tracker',
  ISSUES_EXPLAINER: process.env.CC_HAHA_ISSUES_EXPLAINER || 'open an issue in the project repository',
  VERSION_CHANGELOG: process.env.CC_HAHA_VERSION_CHANGELOG || '',
}
