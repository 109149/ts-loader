///<reference path="node_modules/typescript/bin/typescript.d.ts" />
///<reference path="node_modules/typescript/bin/typescript_internal.d.ts" />
///<reference path="node_modules/typescript/bin/typescriptServices.d.ts" />
///<reference path="typings/node/node.d.ts" />
///<reference path="typings/q/Q.d.ts" />
///<reference path="typings/loaderUtils/loaderUtils.d.ts" />
///<reference path="typings/objectAssign/objectAssign.d.ts" />
///<reference path="typings/colors/colors.d.ts" />
import typescript = require('typescript')
import path = require('path')
import fs = require('fs');
import os = require('os');
import Q = require('q');
import loaderUtils = require('loader-utils');
import objectAssign = require('object-assign');
require('colors');

interface Dependency {
    original: string;
    resolved: string;
    pos: number;
    end: number;
    reference: boolean;
}

interface Options {
    instance: string;
    sourceMap: boolean;
    target: string;
    module: string;
}

interface TSFile {
    text: string;
    version: number;
}

interface TSFiles {
    [fileName: string]: TSFile;
}

interface TSInstance {
    files: TSFiles;
    languageService: typescript.LanguageService;
}

interface TSInstances {
    [name: string]: TSInstance;
}

interface Resolver {
    (context: string, request: string): Q.Promise<string>;
}

var readFile = Q.denodeify<string>(fs.readFile);

var instances = <TSInstances>{};

function ensureTypeScriptInstance(options: Options): TSInstance {

    if (Object.prototype.hasOwnProperty.call(instances, options.instance))
        return instances[options.instance]
    
    var target: typescript.ScriptTarget;
    switch (options.target) {
        case "ES3": target = typescript.ScriptTarget.ES3; break;
        case "ES6": target = typescript.ScriptTarget.ES6; break;
        default: target = typescript.ScriptTarget.ES5;
    }

    var compilerOptions: typescript.CompilerOptions = {
        target: target,
        module: options.module == "AMD" ? typescript.ModuleKind.AMD : typescript.ModuleKind.CommonJS,
        sourceMap: !!options.sourceMap
    }
    
    var files = <TSFiles>{};

    var libPath = path.join(path.dirname(require.resolve('typescript')), 'lib.d.ts');
    files[libPath] = {
        text: fs.readFileSync(libPath, 'utf-8'),
        version: 0
    }

    var servicesHost = {
        getScriptFileNames: () => Object.keys(files),
        getScriptVersion: filename => files[filename] && files[filename].version.toString(),
        getScriptSnapshot: filename => {
            var file = files[filename];
            return {
                getText: (start, end) => file.text.substring(start, end),
                getLength: () => file.text.length,
                getLineStartPositions: () => [],
                getChangeRange: oldSnapshot => undefined
            };
        },
        getCurrentDirectory: () => process.cwd(),
        getScriptIsOpen: () => true,
        getCompilationSettings: () => compilerOptions,
        getDefaultLibFilename: options => 'lib.d.ts',
        // getNewLine() should work in next version of TypeScript
        // see https://github.com/Microsoft/TypeScript/issues/1653
        //getNewLine: () => { return os.EOL },
        log: message => console.log(message)
    };

    var languageService = typescript.createLanguageService(servicesHost, typescript.createDocumentRegistry())
    
    return instances[options.instance] = {
        files: files,
        languageService: languageService
    }
}

function rootReferencePath(referencePath: string, dirname: string) {
    return typescript.isRootedDiskPath(referencePath) ? referencePath : typescript.combinePaths(dirname, referencePath)
}

function ensureDependencies(resolver: Resolver, instance: TSInstance, filePath: string, contents: string): Q.Promise<string> {
    filePath = path.normalize(filePath);

    if (!Object.prototype.hasOwnProperty.call(instance.files, filePath)) {

        var fileInfo = typescript.preProcessFile(contents)

        var dirname = path.dirname(filePath);

        var dependencies = fileInfo.referencedFiles.concat(fileInfo.importedFiles).map(f => <Dependency>({
                original: f.filename,
                resolved: '',
                pos: f.pos,
                end: f.end,
                reference: fileInfo.referencedFiles.indexOf(f) != -1
            }));

        instance.files[filePath] = { version: 0, text: contents }

        return Q.all(dependencies.map(f => resolver(dirname, f.reference ? rootReferencePath(f.original, dirname) : f.original)
                                           .then(newPath => f.resolved = newPath)
                                           .then(newPath => f)))
            .then(filePaths => filePaths.filter(f => f.resolved.match(/\.ts$/) != null)) // filter out any non-ts files
            .then(filePaths => Q.all(filePaths.map(f => readFile(f.resolved, 'utf-8').then(fileContents => ensureDependencies(resolver, instance, f.resolved, fileContents)))))
            .then(() => contents);
    }
    return Q(contents);
}

function loader(contents) {
    this.cacheable && this.cacheable();
    var callback = this.async();
    var filePath = path.normalize(this.resourcePath);
    
    var options = loaderUtils.parseQuery<Options>(this.query);
    options = objectAssign<Options>({}, {
        instance: 'default',
        sourceMap: false
    }, options);
    
    var instance = ensureTypeScriptInstance(options);
    var resolver = Q.denodeify<string>(this.resolve.bind(this));
    
    ensureDependencies(resolver, instance, filePath, contents)
        .then(contents => {
            var file = instance.files[filePath],
                langService = instance.languageService;
            
            file.text = contents;
            file.version++;

            var output = langService.getEmitOutput(filePath);

            var diagnostics = langService.getCompilerOptionsDiagnostics()
                .concat(langService.getSyntacticDiagnostics(filePath))
                .concat(langService.getSemanticDiagnostics(filePath))
                .forEach(diagnostic => {
                    if (diagnostic.file) {
                        var lineChar = diagnostic.file.getLineAndCharacterFromPosition(diagnostic.start);
                        this.emitError(`  ${diagnostic.file.filename.blue} (${lineChar.line.toString().cyan},${lineChar.character.toString().cyan}): ${diagnostic.messageText.red}`)
                    }
                    else {
                        this.emitError(`  ${"unknown file".blue}: ${diagnostic.messageText.red}`)
                    }
                });

            if (output.outputFiles.length == 0) throw new Error(`Typescript emitted no output for ${filePath}`);
            
            var sourceMap: any;
            if (options.sourceMap) {
                contents = output.outputFiles[1].text;
                sourceMap = JSON.parse(output.outputFiles[0].text);
                sourceMap.sourcesContent = [contents];
            }
            else {
                contents = output.outputFiles[0].text;
            }
            contents = contents.replace(/\r\n/g, os.EOL);
            return [contents, sourceMap];
        })
        .done(contents => callback(null, contents[0], contents[1]), err => callback(err));
}

export = loader;