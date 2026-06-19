import babel from "@babel/core";
import ReactCompiler from "babel-plugin-react-compiler";

const reactCompilerPlugin: Bun.BunPlugin = {
    name: "react-compiler",
    setup(build: Bun.PluginBuilder) {
        build.onLoad({ filter: /\.[jt]sx$/ }, async (args) => {
            const input = await Bun.file(args.path).text();
            const result = await babel.transformAsync(input, {
                ast: false,
                babelrc: false,
                configFile: false,
                filename: args.path,
                parserOpts: { plugins: ["jsx", "typescript"] },
                plugins: [[ReactCompiler, {}]],
                sourceMaps: false,
            });

            if (!result?.code) {
                throw new Error(`Failed to compile ${args.path}`);
            }

            return {
                contents: result.code,
                loader: args.path.endsWith(".jsx") ? "jsx" : "tsx",
            };
        });
    },
};

export default reactCompilerPlugin;
