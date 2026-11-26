/**
 * 最小化的 vscode-arduino-api 类型声明。
 *
 * 只声明本扩展用到的部分，避免依赖外部包，方便单独发布。
 * 运行时通过 vscode.extensions.getExtension('dankeboy36.vscode-arduino-api')
 * 拿到真实的 exports，这里仅用于类型检查。
 */

export interface PortIdentifier {
  readonly address?: string;
  readonly protocol?: string;
  readonly properties?: Record<string, string>;
}

export interface CompileSummary {
  readonly buildPath?: string;
}

export interface SketchFolder {
  readonly sketchPath: string;
  readonly fqbn?: string;
  readonly compileSummary?: CompileSummary;
  readonly port?: PortIdentifier;
}

export interface ArduinoContext {
  readonly currentSketch: SketchFolder | undefined;
  readonly openedSketches: readonly SketchFolder[];
}
