import * as babel from "@babel/core";
import ReactCompiler from "babel-plugin-react-compiler";

const reactCompilerPlugin: Bun.BunPlugin = {
    name: "react-compiler",
    setup(build: Bun.PluginBuilder) {
        build.onLoad({ filter: /\.[jt]sx$/ }, async (arguments_) => {
            const input = await Bun.file(arguments_.path).text();
            const result = await babel.transformAsync(input, {
                ast: false,
                babelrc: false,
                configFile: false,
                filename: arguments_.path,
                parserOpts: { plugins: ["jsx", "typescript"] },
                plugins: [[ReactCompiler, {}]],
                sourceMaps: false,
            });

            if (!result?.code) {
                throw new Error(`Failed to compile ${arguments_.path}`);
            }

            return {
                contents: result.code,
                loader: arguments_.path.endsWith(".jsx") ? "jsx" : "tsx",
            };
        });
    },
};

export default reactCompilerPlugin;
