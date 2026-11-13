import { transformSync } from '@babel/core'
import solid from 'babel-preset-solid'

/**
 * The build-time half of the Solid adapter (`@bun-native/solid/build`): the
 * official Solid universal JSX transform. The CLI loads it from the project only
 * for Solid builds, so React projects never install Babel. Project or Babel
 * configuration cannot select DOM output.
 */
export function transformSolid(source: string, filename: string): string {
  const result = transformSync(source, {
    filename,
    babelrc: false,
    configFile: false,
    sourceMaps: false,
    parserOpts: { plugins: ['typescript', 'jsx'] },
    presets: [[solid, { generate: 'universal', moduleName: '@bun-native/solid', dev: false }]],
  })
  if (!result?.code) throw new Error('Solid JSX transform produced no application code')
  return result.code
}
