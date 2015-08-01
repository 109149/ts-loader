///<reference path="typings/typescript/typescript.d.ts" />
///<reference path="typings/node/node.d.ts" />
///<reference path="typings/loaderUtils/loaderUtils.d.ts" />
///<reference path="typings/objectAssign/objectAssign.d.ts" />
///<reference path="typings/colors/colors.d.ts" />
import typescript = require('typescript')
import path = require('path')
import fs = require('fs');
import os = require('os');
import loaderUtils = require('loader-utils');
import objectAssign = require('object-assign');
require('colors');

var pushArray = function(arr, toPush) {
    Array.prototype.push.apply(arr, toPush);
}

interface Options {
    silent: boolean;
    instance: string;
    compiler: string;
    configFileName: string;
}

interface TSFile {
    text: string;
    version: number;
}

interface TSFiles {
    [fileName: string]: TSFile;
}

interface TSInstance {
    compiler: typeof typescript;
    compilerOptions: typescript.CompilerOptions;
    files: TSFiles;
    languageService: typescript.LanguageService;
}

interface TSInstances {
    [name: string]: TSInstance;
}

interface WebpackError {
    module?: any;
    file?: string;
    message: string;
    rawMessage: string;
    location?: {line: number, character: number};
}

var instances = <TSInstances>{};
var webpackInstances = [];

// Take TypeScript errors, parse them and format to webpack errors
// Optionally adds a file name
function formatErrors(diagnostics: typescript.Diagnostic[], compiler: typeof typescript, merge?: any): WebpackError[] {
    return diagnostics
        .map<WebpackError>(diagnostic => {
            var messageText = compiler.flattenDiagnosticMessageText(diagnostic.messageText, os.EOL);
            if (diagnostic.file) {
                var lineChar = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
                return {
                    message: `${'('.white}${(lineChar.line+1).toString().cyan},${(lineChar.character+1).toString().cyan}): ${messageText.red}`,
                    rawMessage: messageText,
                    location: {line: lineChar.line+1, character: lineChar.character+1}
                };
            }
            else {
                return {
                    message:`${messageText.red}`,
                    rawMessage: messageText 
                };
            }
        })
        .map(error => <WebpackError>objectAssign(error, merge));
}

// The tsconfig.json is found using the same method as `tsc`, starting in the current directory 
// and continuing up the parent directory chain.
function findConfigFile(compiler: typeof typescript, searchPath: string, configFileName: string): string {
    while (true) {
        var fileName = path.join(searchPath, configFileName);
        if (compiler.sys.fileExists(fileName)) {
            return fileName;
        }
        var parentPath = path.dirname(searchPath);
        if (parentPath === searchPath) {
            break;
        }
        searchPath = parentPath;
    }
    return undefined;
}

// The loader is executed once for each file seen by webpack. However, we need to keep 
// a persistent instance of TypeScript that contains all of the files in the program
// along with definition files and options. This function either creates an instance
// or returns the existing one. Multiple instances are possible by using the
// `instance` property.
function ensureTypeScriptInstance(options: Options, loader: any): { instance?: TSInstance, error?: WebpackError } {

    function log(...messages: string[]): void {
        if (!options.silent) {
            console.log.apply(console, messages);
        }
    }
    
    if (Object.prototype.hasOwnProperty.call(instances, options.instance)) {
        return { instance: instances[options.instance] };        
    }
    
    var compiler = require(options.compiler);
    var files = <TSFiles>{};
    
    var compilerOptions: typescript.CompilerOptions = {
        module: 1 /* CommonJS */
    };
    
    // Load any available tsconfig.json file
    var filesToLoad = [];
    var configFilePath = findConfigFile(compiler, path.dirname(loader.resourcePath), options.configFileName);
    if (configFilePath) {
        log('Using config file at '.green + configFilePath.blue);
        var configFile = compiler.readConfigFile(configFilePath);
        
        if (configFile.error) {
            var configFileError = formatErrors([configFile.error], compiler, {file: configFilePath })[0];
            return { error: configFileError }
        }
        var configParseResult = compiler.parseConfigFile(configFile.config, compiler.sys, path.dirname(configFilePath));
        
        if (configParseResult.errors.length) {
            pushArray(
                loader._module.errors, 
                formatErrors(configParseResult.errors, compiler, { file: configFilePath }));
            
            return { error: {
                file: configFilePath,
                message: 'error while parsing tsconfig.json'.red,
                rawMessage: 'error while parsing tsconfig.json'
            }};
        }
        
        objectAssign(compilerOptions, configParseResult.options);
        filesToLoad = configParseResult.fileNames;
    }
    
    var libFileName = 'lib.d.ts';

    // Special handling for ES6 targets
    if (compilerOptions.target == 2 /* ES6 */) {
        compilerOptions.module = 0 /* None */;
        libFileName = 'lib.es6.d.ts';
    }
    
    if (!compilerOptions.noLib) {
        filesToLoad.push(path.join(path.dirname(require.resolve('typescript')), libFileName));
    }
    
    // Load initial files (core lib files, any files specified in tsconfig.json)
    filesToLoad.forEach(filePath => {
        filePath = path.normalize(filePath);
        files[filePath] = {
            text: fs.readFileSync(filePath, 'utf-8'),
            version: 0
        }
    });

    // Create the TypeScript language service
    var servicesHost = {
        getScriptFileNames: () => Object.keys(files),
        getScriptVersion: fileName => {
            fileName = path.normalize(fileName);
            return files[fileName] && files[fileName].version.toString();
        },
        getScriptSnapshot: fileName => {
            // This is called any time TypeScript needs a file's text
            // We either load from memory or from disk 
            fileName = path.normalize(fileName);
            var file = files[fileName];
            
            if (!file) {
                try {
                    file = files[fileName] = {
                        version: 0, 
                        text: fs.readFileSync(fileName, {encoding: 'utf8'})
                    }
                }
                catch (e) {
                    return;
                }
            } 
            
            return compiler.ScriptSnapshot.fromString(file.text);
        },
        getCurrentDirectory: () => process.cwd(),
        getCompilationSettings: () => compilerOptions,
        getDefaultLibFileName: options => libFileName,
        getNewLine: () => { return os.EOL },
        log: log
    };

    var languageService = compiler.createLanguageService(servicesHost, compiler.createDocumentRegistry())
    
    var instance: TSInstance = instances[options.instance] = {
        compiler: compiler,
        compilerOptions: compilerOptions,
        files: files,
        languageService: languageService
    };
    
    var compilerOptionDiagnostics = languageService.getCompilerOptionsDiagnostics();
    
    loader._compiler.plugin("done", stats => {
        // handle compiler option errors after the first compile
        pushArray(
            stats.compilation.errors,
            formatErrors(compilerOptionDiagnostics, compiler, {file: configFilePath || 'tsconfig.json'}));
        compilerOptionDiagnostics = [];
        
        // handle errors for all declaration files at the end of each compilation
        Object.keys(instance.files)
            .filter(filePath => !!filePath.match(/\.d\.ts$/))
            .forEach(filePath => {
                pushArray(
                    stats.compilation.errors,
                    formatErrors(
                        languageService.getSyntacticDiagnostics(filePath).concat(languageService.getSemanticDiagnostics(filePath)),
                        compiler,
                        {file: filePath}));
            });
    });
    
    // manually update changed declaration files
    loader._compiler.plugin("watch-run", (watching, cb) => {
        var mtimes = watching.compiler.watchFileSystem.watcher.mtimes;
        Object.keys(mtimes)
            .filter(filePath => !!filePath.match(/\.d\.ts$/))
            .forEach(filePath => {
                filePath = path.normalize(filePath);
                var file = instance.files[filePath];
                if (file) {
                    file.text = fs.readFileSync(filePath, {encoding: 'utf8'});
                    file.version++;
                }
            });
        cb()
    })
    
    return { instance };
}

function loader(contents) {
    this.cacheable && this.cacheable();
    var callback = this.async();
    var filePath = path.normalize(this.resourcePath);
    
    var queryOptions = loaderUtils.parseQuery<Options>(this.query);
    var configFileOptions = this.options.ts || {};
    
    var options = objectAssign<Options>({}, {
        silent: false,
        instance: 'default',
        compiler: 'typescript',
        configFileName: 'tsconfig.json'
    }, configFileOptions, queryOptions);
    
    // differentiate the TypeScript instance based on the webpack instance
    var webpackIndex = webpackInstances.indexOf(this._compiler);
    if (webpackIndex == -1) {
        webpackIndex = webpackInstances.push(this._compiler)-1;
    }
    options.instance = webpackIndex + '_' + options.instance;
    
    var { instance, error } = ensureTypeScriptInstance(options, this);
    
    if (error) {
        callback(error)
        return;
    }
    
    var file = instance.files[filePath],
        langService = instance.languageService;
    
    // Update TypeScript with the new file contents
    if (!file) {
        file = instance.files[filePath] = <TSFile>{ version: 0 };
    }
    
    file.text = contents;
    file.version++;
    
    // Make this file dependent on *all* definition files in the program
    this.clearDependencies();
    this.addDependency(filePath);
    Object.keys(instance.files).filter(filePath => !!filePath.match(/\.d\.ts$/)).forEach(this.addDependency.bind(this));

    // Emit Javascript
    var output = langService.getEmitOutput(filePath);
    pushArray(this._module.errors, formatErrors(
        langService.getSyntacticDiagnostics(filePath).concat(langService.getSemanticDiagnostics(filePath)),
        instance.compiler,
        {module: this._module}
    ));

    if (output.outputFiles.length == 0) throw new Error(`Typescript emitted no output for ${filePath}`);

    var result = output.outputFiles
      .filter(file => !!file.name.match(/\.js$/))
      .pop()
      .text;

    var sourceMap: any = output.outputFiles
      .filter(file => !!file.name.match(/\.js\.map$/))
      .pop();

    if (sourceMap) {
        sourceMap = JSON.parse(sourceMap.text);
        sourceMap.sources = [loaderUtils.getRemainingRequest(this)];
        sourceMap.file = loaderUtils.getCurrentRequest(this);
        sourceMap.sourcesContent = [contents];
        result = result.replace(/^\/\/# sourceMappingURL=[^\r\n]*/gm, '');
    }

    // Make sure webpack is aware that even though the emitted JavaScript may be the same as
    // a previously cached version the TypeScript may be different and therefore should be
    // treated as new
    this._module.meta['tsLoaderFileVersion'] = file.version;

    callback(null, result, sourceMap)
}

export = loader;
