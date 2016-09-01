'use strict';
let main;
let pug_lexer;
let is_expression;
let character_parser;
let pug_error;

// pug https://github.com/pugjs/pug.git
{
    let exports = {};
    /*!
    * Pug
    * Copyright(c) 2010 TJ Holowaychuk <tj@vision-media.ca>
    * MIT Licensed
    */

    /**
     * Module dependencies.
     */

    let path = require('path');
    let lex = pug_lexer;
    let stripComments = require('pug-strip-comments');
    let parse = require('pug-parser');
    let load = require('pug-load');
    let filters = require('pug-filters');
    let link = require('pug-linker');
    let generateCode = require('pug-code-gen');
    let runtime = require('pug-runtime');
    let runtimeWrap = require('pug-runtime/wrap');

    /**
     * Pug runtime helpers.
     */

    exports.runtime = runtime;

    /**
     * Template function cache.
     */

    exports.cache = {};

    function applyPlugins(value, options, plugins, name) {
    return plugins.reduce(function (value, plugin) {
        return (
        plugin[name]
        ? plugin[name](value, options)
        : value
        );
    }, value);
    }

    function findReplacementFunc(plugins, name) {
    let eligiblePlugins = plugins.filter(function (plugin) {
        return plugin[name];
    });

    if (eligiblePlugins.length > 1) {
        throw new Error('Two or more plugins all implement ' + name + ' method.');
    } else if (eligiblePlugins.length) {
        return eligiblePlugins[0][name];
    } else {
        return null;
    }
    }

    /**
     * Object for global custom filters.  Note that you can also just pass a `filters`
     * option to any other method.
     */
    exports.filters = {};

    /**
     * Compile the given `str` of pug and return a function body.
     *
     * @param {String} str
     * @param {Object} options
     * @return {Object}
     * @api private
     */

    function compileBody(str, options){
        let debug_sources = {};
        debug_sources[options.filename] = str;
        let dependencies = [];
        let plugins = options.plugins || [];
        let ast = load.string(str, {
            filename: options.filename,
            basedir: options.basedir,
            lex: function (str, options) {
            let lexOptions = {};
            Object.keys(options).forEach(function (key) {
                lexOptions[key] = options[key];
            });
            lexOptions.plugins = plugins.filter(function (plugin) {
                return !!plugin.lex;
            }).map(function (plugin) {
                return plugin.lex;
            });
            return applyPlugins(lex(str, lexOptions), options, plugins, 'postLex');
            },
            parse: function (tokens, options) {
            tokens = tokens.map(function (token) {
                if (token.type === 'path' && path.extname(token.val) === '') {
                return {
                    type: 'path',
                    line: token.line,
                    col: token.col,
                    val: token.val + '.pug'
                };
                }
                return token;
            });
            tokens = stripComments(tokens, options);
            tokens = applyPlugins(tokens, options, plugins, 'preParse');
            let parseOptions = {};
            Object.keys(options).forEach(function (key) {
                parseOptions[key] = options[key];
            });
            parseOptions.plugins = plugins.filter(function (plugin) {
                return !!plugin.parse;
            }).map(function (plugin) {
                return plugin.parse;
            });

            return applyPlugins(
                applyPlugins(parse(tokens, parseOptions), options, plugins, 'postParse'),
                options, plugins, 'preLoad'
            );
            },
            resolve: function (filename, source, loadOptions) {
            let replacementFunc = findReplacementFunc(plugins, 'resolve');
            if (replacementFunc) {
                return replacementFunc(filename, source, options);
            }

            return load.resolve(filename, source, loadOptions);
            },
            read: function (filename, loadOptions) {
            dependencies.push(filename);

            let contents;

            let replacementFunc = findReplacementFunc(plugins, 'read');
            if (replacementFunc) {
                contents = replacementFunc(filename, options);
            } else {
                contents = load.read(filename, loadOptions);
            }

            let str = applyPlugins(contents, {filename: filename}, plugins, 'preLex');
            debug_sources[filename] = str;
            return str;
            }
        });
        ast = applyPlugins(ast, options, plugins, 'postLoad');
        ast = applyPlugins(ast, options, plugins, 'preFilters');

        let filtersSet = {};
        Object.keys(exports.filters).forEach(function (key) {
            filtersSet[key] = exports.filters[key];
        });
        if (options.filters) {
            Object.keys(options.filters).forEach(function (key) {
            filtersSet[key] = options.filters[key];
            });
        }
        ast = filters.handleFilters(ast, filtersSet, options.filterOptions);

        ast = applyPlugins(ast, options, plugins, 'postFilters');
        ast = applyPlugins(ast, options, plugins, 'preLink');
        ast = link(ast);
        ast = applyPlugins(ast, options, plugins, 'postLink');

        // Compile
        ast = applyPlugins(ast, options, plugins, 'preCodeGen');
        let js = generateCode(ast, {
            pretty: options.pretty,
            compileDebug: options.compileDebug,
            doctype: options.doctype,
            inlineRuntimeFunctions: options.inlineRuntimeFunctions,
            globals: options.globals,
            self: options.self,
            includeSources: options.includeSources ? debug_sources : false,
            templateName: options.templateName
        });
        js = applyPlugins(js, options, plugins, 'postCodeGen');

        // Debug compiler
        if (options.debug) {
            console.error('\nCompiled Function:\n\n\u001b[90m%s\u001b[0m', js.replace(/^/gm, '  '));
        }

        return {body: js, dependencies: dependencies};
    }

    /**
     * Get the template from a string or a file, either compiled on-the-fly or
     * read from cache (if enabled), and cache the template if needed.
     *
     * If `str` is not set, the file specified in `options.filename` will be read.
     *
     * If `options.cache` is true, this function reads the file from
     * `options.filename` so it must be set prior to calling this function.
     *
     * @param {Object} options
     * @param {String=} str
     * @return {Function}
     * @api private
     */
    function handleTemplateCache (options, str) {
    let key = options.filename;
    if (options.cache && exports.cache[key]) {
        return exports.cache[key];
    } else {
        if (str === undefined) str = read(options.filename);
        let templ = exports.compile(str, options);
        if (options.cache) exports.cache[key] = templ;
        return templ;
    }
    }

    /**
     * Compile a `Function` representation of the given pug `str`.
     *
     * Options:
     *
     *   - `compileDebug` when `false` debugging code is stripped from the compiled
         template, when it is explicitly `true`, the source code is included in
        the compiled template for better accuracy.
    *   - `filename` used to improve errors when `compileDebug` is not `false` and to resolve imports/extends
    *
    * @param {String} str
    * @param {Options} options
    * @return {Function}
    * @api public
    */

    exports.compile = function(str, options){
        options = options || {}

        str = String(str);

        let parsed = compileBody(str, {
            compileDebug: options.compileDebug !== false,
            filename: options.filename,
            basedir: options.basedir,
            pretty: options.pretty,
            doctype: options.doctype,
            inlineRuntimeFunctions: options.inlineRuntimeFunctions,
            globals: options.globals,
            self: options.self,
            includeSources: options.compileDebug === true,
            debug: options.debug,
            templateName: 'template',
            filters: options.filters,
            filterOptions: options.filterOptions,
            plugins: options.plugins,
        });

        let res = options.inlineRuntimeFunctions
            ? new Function('', parsed.body + ';return template;')()
            : runtimeWrap(parsed.body);

        res.dependencies = parsed.dependencies;

        return res;
    };

    /**
     * Compile a JavaScript source representation of the given pug `str`.
     *
     * Options:
     *
     *   - `compileDebug` When it is `true`, the source code is included in
     *     the compiled template for better error messages.
     *   - `filename` used to improve errors when `compileDebug` is not `true` and to resolve imports/extends
     *   - `name` the name of the resulting function (defaults to "template")
     *
     * @param {String} str
     * @param {Options} options
     * @return {Object}
     * @api public
     */

    exports.compileClientWithDependenciesTracked = function(str, options){
        options = options || {};

        str = String(str);
        let parsed = compileBody(str, {
            compileDebug: options.compileDebug,
            filename: options.filename,
            basedir: options.basedir,
            pretty: options.pretty,
            doctype: options.doctype,
            inlineRuntimeFunctions: options.inlineRuntimeFunctions !== false,
            globals: options.globals,
            self: options.self,
            includeSources: options.compileDebug,
            debug: options.debug,
            templateName: options.name || 'template',
            filters: options.filters,
            filterOptions: options.filterOptions,
            plugins: options.plugins,
        });

        return {body: parsed.body, dependencies: parsed.dependencies};
    };

    /**
     * Compile a JavaScript source representation of the given pug `str`.
     *
     * Options:
     *
     *   - `compileDebug` When it is `true`, the source code is included in
     *     the compiled template for better error messages.
     *   - `filename` used to improve errors when `compileDebug` is not `true` and to resolve imports/extends
     *   - `name` the name of the resulting function (defaults to "template")
     *
     * @param {String} str
     * @param {Options} options
     * @return {String}
     * @api public
     */
    exports.compileClient = function (str, options) {
        return exports.compileClientWithDependenciesTracked(str, options).body;
    };

    /**
     * Compile a `Function` representation of the given pug file.
     *
     * Options:
     *
     *   - `compileDebug` when `false` debugging code is stripped from the compiled
         template, when it is explicitly `true`, the source code is included in
        the compiled template for better accuracy.
    *
    * @param {String} path
    * @param {Options} options
    * @return {Function}
    * @api public
    */
    exports.compileFile = function (path, options) {
        options = options || {};
        options.filename = path;
        return handleTemplateCache(options);
    };

    /**
     * Render the given `str` of pug.
     *
     * Options:
     *
     *   - `cache` enable template caching
     *   - `filename` filename required for `include` / `extends` and caching
     *
     * @param {String} str
     * @param {Object|Function} options or fn
     * @param {Function|undefined} fn
     * @returns {String}
     * @api public
     */

    exports.render = function(str, options, fn){
        // support callback API
        if ('function' == typeof options) {
            fn = options, options = undefined;
        }
        if (typeof fn === 'function') {
            let res
            try {
                res = exports.render(str, options);
            } catch (ex) {
                return fn(ex);
            }
            return fn(null, res);
        }

        options = options || {};

        // cache requires .filename
        if (options.cache && !options.filename) {
            throw new Error('the "filename" option is required for caching');
        }

        return handleTemplateCache(options, str)(options);
    };

    /**
     * Render a Pug file at the given `path`.
     *
     * @param {String} path
     * @param {Object|Function} options or callback
     * @param {Function|undefined} fn
     * @returns {String}
     * @api public
     */

    exports.renderFile = function(path, options, fn){
    // support callback API
    if ('function' == typeof options) {
        fn = options, options = undefined;
    }
    if (typeof fn === 'function') {
        let res
        try {
            res = exports.renderFile(path, options);
        } catch (ex) {
            return fn(ex);
        }
        return fn(null, res);
    }

    options = options || {};

    options.filename = path;
        return handleTemplateCache(options)(options);
    };


    /**
     * Compile a Pug file at the given `path` for use on the client.
     *
     * @param {String} path
     * @param {Object} options
     * @returns {String}
     * @api public
     */

    exports.compileFileClient = function(path, options){
    let key = path + ':client';
    options = options || {};

    options.filename = path;

    if (options.cache && exports.cache[key]) {
        return exports.cache[key];
    }

    let str = read(options.filename);
    let out = exports.compileClient(str, options);
    if (options.cache) exports.cache[key] = out;
        return out;
    };

    /**
     * Express support.
     */

    exports.__express = function(path, options, fn) {
        if(options.compileDebug == undefined && process.env.NODE_ENV === 'production') {
            options.compileDebug = false;
        }
        exports.renderFile(path, options, fn);
    }
    main = exports;
}

{

    let module = {exports:{}};
    let assert = require('assert');
    let isExpression = is_expression;
    let characterParser = character_parser;
    let error = pug_error;

    module.exports = lex;
    module.exports.Lexer = Lexer;
    let lex = (str, options) => {
        let lexer = new Lexer(str, options);
        return JSON.parse(JSON.stringify(lexer.getTokens()));
    }

    /**
     * Initialize `Lexer` with the given `str`.
     *
     * @param {String} str
     * @param {String} filename
     * @api private
     */

    function Lexer(str, options) {
    options = options || {};
    if (typeof str !== 'string') {
        throw new Error('Expected source code to be a string but got "' + (typeof str) + '"')
    }
    if (typeof options !== 'object') {
        throw new Error('Expected "options" to be an object but got "' + (typeof options) + '"')
    }
    //Strip any UTF-8 BOM off of the start of `str`, if it exists.
    str = str.replace(/^\uFEFF/, '');
    this.input = str.replace(/\r\n|\r/g, '\n');
    this.originalInput = this.input;
    this.filename = options.filename;
    this.interpolated = options.interpolated || false;
    this.lineno = options.startingLine || 1;
    this.colno = options.startingColumn || 1;
    this.plugins = options.plugins || [];
    this.indentStack = [0];
    this.indentRe = null;
    // If #{} or !{} syntax is allowed when adding text
    this.interpolationAllowed = true;

    this.tokens = [];
    this.ended = false;
    };

    /**
     * Lexer prototype.
     */

    Lexer.prototype = {

    constructor: Lexer,

    error: function (code, message) {
        let err = error(code, message, {line: this.lineno, column: this.colno, filename: this.filename, src: this.originalInput});
        throw err;
    },

    assert: function (value, message) {
        if (!value) this.error('ASSERT_FAILED', message);
    },

    assertExpression: function (exp, noThrow) {
        //this verifies that a JavaScript expression is valid
        try {
        return isExpression(exp, {
            throw: !noThrow,
            ecmaVersion: 6
        });
        } catch (ex) {
        // not coming from acorn
        if (!ex.loc) throw ex;

        this.incrementLine(ex.loc.line - 1);
        this.incrementColumn(ex.loc.column);
        let msg = 'Syntax Error: ' + ex.message.replace(/ \([0-9]+:[0-9]+\)$/, '');
        this.error('SYNTAX_ERROR', msg);
        }
    },

    assertNestingCorrect: function (exp) {
        //this verifies that code is properly nested, but allows
        //invalid JavaScript such as the contents of `attributes`
        let res = characterParser(exp)
        if (res.isNesting()) {
        this.error('INCORRECT_NESTING', 'Nesting must match on expression `' + exp + '`')
        }
    },

    /**
     * Construct a token with the given `type` and `val`.
     *
     * @param {String} type
     * @param {String} val
     * @return {Object}
     * @api private
     */

    tok: function(type, val){
        let res = {type: type, line: this.lineno, col: this.colno};

        if (val !== undefined) res.val = val;

        return res;
    },

    /**
     * Increment `this.lineno` and reset `this.colno`.
     *
     * @param {Number} increment
     * @api private
     */

    incrementLine: function(increment){
        this.lineno += increment;
        if (increment) this.colno = 1;
    },

    /**
     * Increment `this.colno`.
     *
     * @param {Number} increment
     * @api private
     */

    incrementColumn: function(increment){
        this.colno += increment
    },

    /**
     * Consume the given `len` of input.
     *
     * @param {Number} len
     * @api private
     */

    consume: function(len){
        this.input = this.input.substr(len);
    },

    /**
     * Scan for `type` with the given `regexp`.
     *
     * @param {String} type
     * @param {RegExp} regexp
     * @return {Object}
     * @api private
     */

    scan: function(regexp, type){
        let captures;
        if (captures = regexp.exec(this.input)) {
        let len = captures[0].length;
        let val = captures[1];
        let diff = len - (val ? val.length : 0);
        let tok = this.tok(type, val);
        this.consume(len);
        this.incrementColumn(diff);
        return tok;
        }
    },
    scanEndOfLine: function (regexp, type) {
        let captures;
        if (captures = regexp.exec(this.input)) {
        let whitespaceLength = 0;
        let whitespace;
        let tok;
        if (whitespace = /^([ ]+)([^ ]*)/.exec(captures[0])) {
            whitespaceLength = whitespace[1].length;
            this.incrementColumn(whitespaceLength);
        }
        let newInput = this.input.substr(captures[0].length);
        if (newInput[0] === ':') {
            this.input = newInput;
            tok = this.tok(type, captures[1]);
            this.incrementColumn(captures[0].length - whitespaceLength);
            return tok;
        }
        if (/^[ \t]*(\n|$)/.test(newInput)) {
            this.input = newInput.substr(/^[ \t]*/.exec(newInput)[0].length);
            tok = this.tok(type, captures[1]);
            this.incrementColumn(captures[0].length - whitespaceLength);
            return tok;
        }
        }
    },

    /**
     * Return the indexOf `(` or `{` or `[` / `)` or `}` or `]` delimiters.
     *
     * Make sure that when calling this function, colno is at the character
     * immediately before the beginning.
     *
     * @return {Number}
     * @api private
     */

    bracketExpression: function(skip){
        skip = skip || 0;
        let start = this.input[skip];
        assert(start === '(' || start === '{' || start === '[',
            'The start character should be "(", "{" or "["');
        let end = characterParser.BRACKETS[start];
        let range;
        try {
        range = characterParser.parseUntil(this.input, end, {start: skip + 1});
        } catch (ex) {
        if (ex.index !== undefined) {
            let idx = ex.index;
            // starting from this.input[skip]
            let tmp = this.input.substr(skip).indexOf('\n');
            // starting from this.input[0]
            let nextNewline = tmp + skip;
            let ptr = 0;
            while (idx > nextNewline && tmp !== -1) {
            this.incrementLine(1);
            idx -= nextNewline + 1;
            ptr += nextNewline + 1;
            tmp = nextNewline = this.input.substr(ptr).indexOf('\n');
            };

            this.incrementColumn(idx);
        }
        if (ex.code === 'CHARACTER_PARSER:END_OF_STRING_REACHED') {
            this.error('NO_END_BRACKET', 'The end of the string reached with no closing bracket ' + end + ' found.');
        } else if (ex.code === 'CHARACTER_PARSER:MISMATCHED_BRACKET') {
            this.error('BRACKET_MISMATCH', ex.message);
        }
        throw ex;
        }
        return range;
    },

    scanIndentation: function() {
        let captures, re;

        // established regexp
        if (this.indentRe) {
        captures = this.indentRe.exec(this.input);
        // determine regexp
        } else {
        // tabs
        re = /^\n(\t*) */;
        captures = re.exec(this.input);

        // spaces
        if (captures && !captures[1].length) {
            re = /^\n( *)/;
            captures = re.exec(this.input);
        }

        // established
        if (captures && captures[1].length) this.indentRe = re;
        }

        return captures;
    },

    /**
     * end-of-source.
     */

    eos: function() {
        if (this.input.length) return;
        if (this.interpolated) {
        this.error('NO_END_BRACKET', 'End of line was reached with no closing bracket for interpolation.');
        }
        for (let i = 0; this.indentStack[i]; i++) {
        this.tokens.push(this.tok('outdent'));
        }
        this.tokens.push(this.tok('eos'));
        this.ended = true;
        return true;
    },

    /**
     * Blank line.
     */

    blank: function() {
        let captures;
        if (captures = /^\n[ \t]*\n/.exec(this.input)) {
        this.consume(captures[0].length - 1);
        this.incrementLine(1);
        return true;
        }
    },

    /**
     * Comment.
     */

    comment: function() {
        let captures;
        if (captures = /^\/\/(-)?([^\n]*)/.exec(this.input)) {
        this.consume(captures[0].length);
        let tok = this.tok('comment', captures[2]);
        tok.buffer = '-' != captures[1];
        this.interpolationAllowed = tok.buffer;
        this.tokens.push(tok);
        this.incrementColumn(captures[0].length);
        this.callLexerFunction('pipelessText');
        return true;
        }
    },

    /**
     * Interpolated tag.
     */

    interpolation: function() {
        if (/^#\{/.test(this.input)) {
        let match = this.bracketExpression(1);
        this.consume(match.end + 1);
        let tok = this.tok('interpolation', match.src);
        this.tokens.push(tok);
        this.incrementColumn(2); // '#{'
        this.assertExpression(match.src);

        let splitted = match.src.split('\n');
        let lines = splitted.length - 1;
        this.incrementLine(lines);
        this.incrementColumn(splitted[lines].length + 1); // + 1 → '}'
        return true;
        }
    },

    /**
     * Tag.
     */

    tag: function() {
        let captures;

        if (captures = /^(\w(?:[-:\w]*\w)?)/.exec(this.input)) {
        let tok, name = captures[1], len = captures[0].length;
        this.consume(len);
        tok = this.tok('tag', name);
        this.tokens.push(tok);
        this.incrementColumn(len);
        return true;
        }
    },

    /**
     * Filter.
     */

    filter: function(opts) {
        let tok = this.scan(/^:([\w\-]+)/, 'filter');
        let inInclude = opts && opts.inInclude;
        if (tok) {
        this.tokens.push(tok);
        this.incrementColumn(tok.val.length);
        this.callLexerFunction('attrs');
        if (!inInclude) {
            this.interpolationAllowed = false;
            this.callLexerFunction('pipelessText');
        }
        return true;
        }
    },

    /**
     * Doctype.
     */

    doctype: function() {
        let node = this.scanEndOfLine(/^doctype *([^\n]*)/, 'doctype');
        if (node) {
        this.tokens.push(node);
        return true;
        }
    },

    /**
     * Id.
     */

    id: function() {
        let tok = this.scan(/^#([\w-]+)/, 'id');
        if (tok) {
        this.tokens.push(tok);
        this.incrementColumn(tok.val.length);
        return true;
        }
        if (/^#/.test(this.input)) {
        this.error('INVALID_ID', '"' + /.[^ \t\(\#\.\:]*/.exec(this.input.substr(1))[0] + '" is not a valid ID.');
        }
    },

    /**
     * Class.
     */

    className: function() {
        let tok = this.scan(/^\.(\-?[_a-z][_a-z0-9\-]*)/i, 'class');
        if (tok) {
        this.tokens.push(tok);
        this.incrementColumn(tok.val.length);
        return true;
        }
        if (/^\.\-/i.test(this.input)) {
        this.error('INVALID_CLASS_NAME', 'If a class name begins with a "-", it must be followed by a letter or underscore.');
        }
        if (/^\.[0-9]/i.test(this.input)) {
        this.error('INVALID_CLASS_NAME', 'Class names must begin with "-", "_" or a letter.');
        }
        if (/^\./.test(this.input)) {
        this.error('INVALID_CLASS_NAME', '"' + /.[^ \t\(\#\.\:]*/.exec(this.input.substr(1))[0] + '" is not a valid class name.  Class names must begin with "-", "_" or a letter and can only contain "_", "-", a-z and 0-9.');
        }
    },

    /**
     * Text.
     */
    endInterpolation: function () {
        if (this.interpolated && this.input[0] === ']') {
        this.input = this.input.substr(1);
        this.ended = true;
        return true;
        }
    },
    addText: function (type, value, prefix, escaped) {
        if (value + prefix === '') return;
        prefix = prefix || '';
        let indexOfEnd = this.interpolated ? value.indexOf(']') : -1;
        let indexOfStart = value.indexOf('#[');
        let indexOfEscaped = value.indexOf('\\#[');
        let matchOfStringInterp = /(\\)?([#!]){((?:.|\n)*)$/.exec(value);
        let indexOfStringInterp = this.interpolationAllowed && matchOfStringInterp ? matchOfStringInterp.index : Infinity;

        if (indexOfEnd === -1) indexOfEnd = Infinity;
        if (indexOfStart === -1) indexOfStart = Infinity;
        if (indexOfEscaped === -1) indexOfEscaped = Infinity;

        if (indexOfEscaped !== Infinity && indexOfEscaped < indexOfEnd && indexOfEscaped < indexOfStart && indexOfEscaped < indexOfStringInterp) {
        prefix = prefix + value.substring(0, indexOfEscaped) + '#[';
        return this.addText(type, value.substring(indexOfEscaped + 3), prefix, true);
        }
        if (indexOfStart !== Infinity && indexOfStart < indexOfEnd && indexOfStart < indexOfEscaped && indexOfStart < indexOfStringInterp) {
        this.tokens.push(this.tok(type, prefix + value.substring(0, indexOfStart)));
        this.incrementColumn(prefix.length + indexOfStart);
        if (escaped) this.incrementColumn(1);
        this.tokens.push(this.tok('start-pug-interpolation'));
        this.incrementColumn(2);
        let child = new this.constructor(value.substr(indexOfStart + 2), {
            filename: this.filename,
            interpolated: true,
            startingLine: this.lineno,
            startingColumn: this.colno
        });
        let interpolated;
        try {
            interpolated = child.getTokens();
        } catch (ex) {
            if (ex.code && /^PUG:/.test(ex.code)) {
            this.colno = ex.column;
            this.error(ex.code.substr(4), ex.msg);
            }
            throw ex;
        }
        this.colno = child.colno;
        this.tokens = this.tokens.concat(interpolated);
        this.tokens.push(this.tok('end-pug-interpolation'));
        this.incrementColumn(1);
        this.addText(type, child.input);
        return;
        }
        if (indexOfEnd !== Infinity && indexOfEnd < indexOfStart && indexOfEnd < indexOfEscaped && indexOfEnd < indexOfStringInterp) {
        if (prefix + value.substring(0, indexOfEnd)) {
            this.addText(type, value.substring(0, indexOfEnd), prefix);
        }
        this.ended = true;
        this.input = value.substr(value.indexOf(']') + 1) + this.input;
        return;
        }
        if (indexOfStringInterp !== Infinity) {
        if (matchOfStringInterp[1]) {
            prefix = prefix + value.substring(0, indexOfStringInterp) + '#{';
            return this.addText(type, value.substring(indexOfStringInterp + 3), prefix);
        }
        let before = value.substr(0, indexOfStringInterp);
        if (prefix || before) {
            before = prefix + before;
            this.tokens.push(this.tok(type, before));
            this.incrementColumn(before.length);
        }

        let rest = matchOfStringInterp[3];
        let range;
        let tok = this.tok('interpolated-code');
        this.incrementColumn(2);
        try {
            range = characterParser.parseUntil(rest, '}');
        } catch (ex) {
            if (ex.index !== undefined) {
            this.incrementColumn(ex.index);
            }
            if (ex.code === 'CHARACTER_PARSER:END_OF_STRING_REACHED') {
            this.error('NO_END_BRACKET', 'End of line was reached with no closing bracket for interpolation.');
            } else if (ex.code === 'CHARACTER_PARSER:MISMATCHED_BRACKET') {
            this.error('BRACKET_MISMATCH', ex.message);
            } else {
            throw ex;
            }
        }
        tok.mustEscape = matchOfStringInterp[2] === '#';
        tok.buffer = true;
        tok.val = range.src;
        this.assertExpression(range.src);
        this.tokens.push(tok);

        if (range.end + 1 < rest.length) {
            rest = rest.substr(range.end + 1);
            this.incrementColumn(range.end + 1);
            this.addText(type, rest);
        } else {
            this.incrementColumn(rest.length);
        }
        return;
        }

        value = prefix + value;
        this.tokens.push(this.tok(type, value));
        this.incrementColumn(value.length);
    },

    text: function() {
        let tok = this.scan(/^(?:\| ?| )([^\n]+)/, 'text') ||
        this.scan(/^\|?( )/, 'text');
        if (tok) {
        this.addText('text', tok.val);
        return true;
        }
    },

    textHtml: function () {
        let tok = this.scan(/^(<[^\n]*)/, 'text-html');
        if (tok) {
        this.addText('text-html', tok.val);
        return true;
        }
    },

    /**
     * Dot.
     */

    dot: function() {
        let tok;
        if (tok = this.scanEndOfLine(/^\./, 'dot')) {
        this.tokens.push(tok);
        this.callLexerFunction('pipelessText');
        return true;
        }
    },

    /**
     * Extends.
     */

    "extends": function() {
        let tok = this.scan(/^extends?(?= |$|\n)/, 'extends');
        if (tok) {
        this.tokens.push(tok);
        if (!this.callLexerFunction('path')) {
            this.error('NO_EXTENDS_PATH', 'missing path for extends');
        }
        return true;
        }
        if (this.scan(/^extends?\b/)) {
        this.error('MALFORMED_EXTENDS', 'malformed extends');
        }
    },

    /**
     * Block prepend.
     */

    prepend: function() {
        let captures;
        if (captures = /^(?:block +)?prepend +([^\n]+)/.exec(this.input)) {
        let name = captures[1].trim();
        let comment = '';
        if (name.indexOf('//') !== -1) {
            comment = '//' + name.split('//').slice(1).join('//');
            name = name.split('//')[0].trim();
        }
        if (!name) return;
        this.consume(captures[0].length - comment.length);
        let tok = this.tok('block', name);
        tok.mode = 'prepend';
        this.tokens.push(tok);
        return true;
        }
    },

    /**
     * Block append.
     */

    append: function() {
        let captures;
        if (captures = /^(?:block +)?append +([^\n]+)/.exec(this.input)) {
        let name = captures[1].trim();
        let comment = '';
        if (name.indexOf('//') !== -1) {
            comment = '//' + name.split('//').slice(1).join('//');
            name = name.split('//')[0].trim();
        }
        if (!name) return;
        this.consume(captures[0].length - comment.length);
        let tok = this.tok('block', name);
        tok.mode = 'append';
        this.tokens.push(tok);
        return true;
        }
    },

    /**
     * Block.
     */

    block: function() {
        let captures;
        if (captures = /^block +([^\n]+)/.exec(this.input)) {
        let name = captures[1].trim();
        let comment = '';
        if (name.indexOf('//') !== -1) {
            comment = '//' + name.split('//').slice(1).join('//');
            name = name.split('//')[0].trim();
        }
        if (!name) return;
        this.consume(captures[0].length - comment.length);
        let tok = this.tok('block', name);
        tok.mode = 'replace';
        this.tokens.push(tok);
        return true;
        }
    },

    /**
     * Mixin Block.
     */

    mixinBlock: function() {
        let tok;
        if (tok = this.scanEndOfLine(/^block/, 'mixin-block')) {
        this.tokens.push(tok);
        return true;
        }
    },

    /**
     * Yield.
     */

    'yield': function() {
        let tok = this.scanEndOfLine(/^yield/, 'yield');
        if (tok) {
        this.tokens.push(tok);
        return true;
        }
    },

    /**
     * Include.
     */

    include: function() {
        let tok = this.scan(/^include(?=:| |$|\n)/, 'include');
        if (tok) {
        this.tokens.push(tok);
        while (this.callLexerFunction('filter', { inInclude: true }));
        if (!this.callLexerFunction('path')) {
            if (/^[^ \n]+/.test(this.input)) {
            // if there is more text
            this.fail();
            } else {
            // if not
            this.error('NO_INCLUDE_PATH', 'missing path for include');
            }
        }
        return true;
        }
        if (this.scan(/^include\b/)) {
        this.error('MALFORMED_INCLUDE', 'malformed include');
        }
    },

    /**
     * Path
     */

    path: function() {
        let tok = this.scanEndOfLine(/^ ([^\n]+)/, 'path');
        if (tok && (tok.val = tok.val.trim())) {
        this.tokens.push(tok);
        return true;
        }
    },

    /**
     * Case.
     */

    "case": function() {
        let tok = this.scanEndOfLine(/^case +([^\n]+)/, 'case');
        if (tok) {
        this.incrementColumn(-tok.val.length);
        this.assertExpression(tok.val);
        this.incrementColumn(tok.val.length);
        this.tokens.push(tok);
        return true;
        }
        if (this.scan(/^case\b/)) {
        this.error('NO_CASE_EXPRESSION', 'missing expression for case');
        }
    },

    /**
     * When.
     */

    when: function() {
        let tok = this.scanEndOfLine(/^when +([^:\n]+)/, 'when');
        if (tok) {
        let parser = characterParser(tok.val);
        while (parser.isNesting() || parser.isString()) {
            let rest = /:([^:\n]+)/.exec(this.input);
            if (!rest) break;

            tok.val += rest[0];
            this.consume(rest[0].length);
            this.incrementColumn(rest[0].length);
            parser = characterParser(tok.val);
        }

        this.incrementColumn(-tok.val.length);
        this.assertExpression(tok.val);
        this.incrementColumn(tok.val.length);
        this.tokens.push(tok);
        return true;
        }
        if (this.scan(/^when\b/)) {
        this.error('NO_WHEN_EXPRESSION', 'missing expression for when');
        }
    },

    /**
     * Default.
     */

    "default": function() {
        let tok = this.scanEndOfLine(/^default/, 'default');
        if (tok) {
        this.tokens.push(tok);
        return true;
        }
        if (this.scan(/^default\b/)) {
        this.error('DEFAULT_WITH_EXPRESSION', 'default should not have an expression');
        }
    },

    /**
     * Call mixin.
     */

    call: function(){

        let tok, captures, increment;
        if (captures = /^\+(\s*)(([-\w]+)|(#\{))/.exec(this.input)) {
        // try to consume simple or interpolated call
        if (captures[3]) {
            // simple call
            increment = captures[0].length;
            this.consume(increment);
            tok = this.tok('call', captures[3]);
        } else {
            // interpolated call
            let match = this.bracketExpression(2 + captures[1].length);
            increment = match.end + 1;
            this.consume(increment);
            this.assertExpression(match.src);
            tok = this.tok('call', '#{'+match.src+'}');
        }

        this.incrementColumn(increment);

        tok.args = null;
        // Check for args (not attributes)
        if (captures = /^ *\(/.exec(this.input)) {
            let range = this.bracketExpression(captures[0].length - 1);
            if (!/^\s*[-\w]+ *=/.test(range.src)) { // not attributes
            this.incrementColumn(1);
            this.consume(range.end + 1);
            tok.args = range.src;
            this.assertExpression('[' + tok.args + ']');
            for (let i = 0; i <= tok.args.length; i++) {
                if (tok.args[i] === '\n') {
                this.incrementLine(1);
                } else {
                this.incrementColumn(1);
                }
            }
            }
        }
        this.tokens.push(tok);
        return true;
        }
    },

    /**
     * Mixin.
     */

    mixin: function(){
        let captures;
        if (captures = /^mixin +([-\w]+)(?: *\((.*)\))? */.exec(this.input)) {
        this.consume(captures[0].length);
        let tok = this.tok('mixin', captures[1]);
        tok.args = captures[2] || null;
        this.tokens.push(tok);
        return true;
        }
    },

    /**
     * Conditional.
     */

    conditional: function() {
        let captures;
        if (captures = /^(if|unless|else if|else)\b([^\n]*)/.exec(this.input)) {
        this.consume(captures[0].length);
        let type = captures[1].replace(/ /g, '-');
        let js = captures[2] && captures[2].trim();
        // type can be "if", "else-if" and "else"
        let tok = this.tok(type, js);
        this.incrementColumn(captures[0].length - js.length);

        switch (type) {
            case 'if':
            case 'else-if':
            this.assertExpression(js);
            break;
            case 'unless':
            this.assertExpression(js);
            tok.val = '!(' + js + ')';
            tok.type = 'if';
            break;
            case 'else':
            if (js) {
                this.error(
                'ELSE_CONDITION',
                '`else` cannot have a condition, perhaps you meant `else if`'
                );
            }
            break;
        }
        this.tokens.push(tok);
        return true;
        }
    },

    /**
     * While.
     */

    "while": function() {
        let captures;
        if (captures = /^while +([^\n]+)/.exec(this.input)) {
        this.consume(captures[0].length);
        this.assertExpression(captures[1])
        this.tokens.push(this.tok('while', captures[1]));
        return true;
        }
        if (this.scan(/^while\b/)) {
        this.error('NO_WHILE_EXPRESSION', 'missing expression for while');
        }
    },

    /**
     * Each.
     */

    each: function() {
        let captures;
        if (captures = /^(?:each|for) +([a-zA-Z_$][\w$]*)(?: *, *([a-zA-Z_$][\w$]*))? * in *([^\n]+)/.exec(this.input)) {
        this.consume(captures[0].length);
        let tok = this.tok('each', captures[1]);
        tok.key = captures[2] || null;
        this.incrementColumn(captures[0].length - captures[3].length);
        this.assertExpression(captures[3])
        tok.code = captures[3];
        this.incrementColumn(captures[3].length);
        this.tokens.push(tok);
        return true;
        }
        if (this.scan(/^(?:each|for)\b/)) {
        this.error('MALFORMED_EACH', 'malformed each');
        }
        if (captures = /^- *(?:each|for) +([a-zA-Z_$][\w$]*)(?: *, *([a-zA-Z_$][\w$]*))? +in +([^\n]+)/.exec(this.input)) {
        this.error(
            'MALFORMED_EACH',
            'Pug each and for should no longer be prefixed with a dash ("-"). They are pug keywords and not part of JavaScript.'
        );
        }
    },

    /**
     * Code.
     */

    code: function() {
        let captures;
        if (captures = /^(!?=|-)[ \t]*([^\n]+)/.exec(this.input)) {
        let flags = captures[1];
        let code = captures[2];
        let shortened = 0;
        if (this.interpolated) {
            let parsed;
            try {
            parsed = characterParser.parseUntil(code, ']');
            } catch (err) {
            if (err.index !== undefined) {
                this.incrementColumn(captures[0].length - code.length + err.index);
            }
            if (err.code === 'CHARACTER_PARSER:END_OF_STRING_REACHED') {
                this.error('NO_END_BRACKET', 'End of line was reached with no closing bracket for interpolation.');
            } else if (err.code === 'CHARACTER_PARSER:MISMATCHED_BRACKET') {
                this.error('BRACKET_MISMATCH', err.message);
            } else {
                throw err;
            }
            }
            shortened = code.length - parsed.end;
            code = parsed.src;
        }
        let consumed = captures[0].length - shortened;
        this.consume(consumed);
        let tok = this.tok('code', code);
        tok.mustEscape = flags.charAt(0) === '=';
        tok.buffer = flags.charAt(0) === '=' || flags.charAt(1) === '=';

        // p #[!=    abc] hey
        //     ^              original colno
        //     -------------- captures[0]
        //           -------- captures[2]
        //     ------         captures[0] - captures[2]
        //           ^        after colno

        // =   abc
        // ^                  original colno
        // -------            captures[0]
        //     ---            captures[2]
        // ----               captures[0] - captures[2]
        //     ^              after colno
        this.incrementColumn(captures[0].length - captures[2].length);
        if (tok.buffer) this.assertExpression(code);
        this.tokens.push(tok);

        // p #[!=    abc] hey
        //           ^        original colno
        //              ----- shortened
        //           ---      code
        //              ^     after colno

        // =   abc
        //     ^              original colno
        //                    shortened
        //     ---            code
        //        ^           after colno
        this.incrementColumn(code.length);
        return true;
        }
    },

    /**
     * Block code.
     */
    blockCode: function() {
        let tok
        if (tok = this.scanEndOfLine(/^-/, 'blockcode')) {
        this.tokens.push(tok);
        this.interpolationAllowed = false;
        this.callLexerFunction('pipelessText');
        return true;
        }
    },

    /**
     * Attributes.
     */

    attrs: function() {
        if ('(' == this.input.charAt(0)) {
        let startingLine = this.lineno;
        this.tokens.push(this.tok('start-attributes'));
        let index = this.bracketExpression().end
            , str = this.input.substr(1, index-1);

        this.incrementColumn(1);
        this.assertNestingCorrect(str);

        let quote = '';
        let self = this;

        this.consume(index + 1);

        let whitespaceRe = /[ \n\t]/;
        let quoteRe = /['"]/;

        let escapedAttr = true
        let key = '';
        let val = '';
        let state = characterParser.defaultState();
        let lineno = startingLine;
        let colnoBeginAttr = this.colno;
        let colnoBeginVal;
        let loc = 'key';
        let isEndOfAttribute = function (i) {
            // if the key is not started, then the attribute cannot be ended
            if (key.trim() === '') {
            colnoBeginAttr = this.colno;
            return false;
            }
            // if there's nothing more then the attribute must be ended
            if (i === str.length) return true;

            if (loc === 'key') {
            if (whitespaceRe.test(str[i])) {
                // find the first non-whitespace character
                for (let x = i; x < str.length; x++) {
                if (!whitespaceRe.test(str[x])) {
                    // starts a `value`
                    if (str[x] === '=' || str[x] === '!') return false;
                    // will be handled when x === i
                    else if (str[x] === ',') return false;
                    // attribute ended
                    else return true;
                }
                }
            }
            // if there's no whitespace and the character is not ',', the
            // attribute did not end.
            return str[i] === ',';
            } else if (loc === 'value') {
            // if the character is in a string or in parentheses/brackets/braces
            if (state.isNesting() || state.isString()) return false;
            // if the current value expression is not valid JavaScript, then
            // assume that the user did not end the value
            if (!self.assertExpression(val, true)) return false;
            if (whitespaceRe.test(str[i])) {
                // find the first non-whitespace character
                for (let x = i; x < str.length; x++) {
                if (!whitespaceRe.test(str[x])) {
                    // if it is a JavaScript punctuator, then assume that it is
                    // a part of the value
                    return !characterParser.isPunctuator(str[x]) || quoteRe.test(str[x]);
                }
                }
            }
            // if there's no whitespace and the character is not ',', the
            // attribute did not end.
            return str[i] === ',';
            }
        }

        for (let i = 0; i <= str.length; i++) {
            if (isEndOfAttribute.call(this, i)) {
            if (val.trim()) {
                let saved = this.colno;
                this.colno = colnoBeginVal;
                this.assertExpression(val);
                this.colno = saved;
            }

            val = val.trim();

            if (key[0] === ':') this.incrementColumn(-key.length);
            else if (key[key.length - 1] === ':') this.incrementColumn(-1);
            if (key[0] === ':' || key[key.length - 1] === ':') {
                this.error('COLON_ATTRIBUTE', '":" is not valid as the start or end of an un-quoted attribute.');
            }
            key = key.trim();
            key = key.replace(/^['"]|['"]$/g, '');

            let tok = this.tok('attribute');
            tok.name = key;
            tok.val = '' == val ? true : val;
            tok.col = colnoBeginAttr;
            tok.mustEscape = escapedAttr;
            this.tokens.push(tok);

            key = val = '';
            loc = 'key';
            escapedAttr = false;
            this.lineno = lineno;
            } else {
            switch (loc) {
                case 'key-char':
                if (str[i] === quote) {
                    loc = 'key';
                    if (i + 1 < str.length && !/[ ,!=\n\t]/.test(str[i + 1]))
                    this.error('INVALID_KEY_CHARACTER', 'Unexpected character "' + str[i + 1] + '" expected ` `, `\\n`, `\t`, `,`, `!` or `=`');
                } else {
                    key += str[i];
                }
                break;
                case 'key':
                if (key === '' && quoteRe.test(str[i])) {
                    loc = 'key-char';
                    quote = str[i];
                } else if (str[i] === '!' || str[i] === '=') {
                    escapedAttr = str[i] !== '!';
                    if (str[i] === '!') {
                    this.incrementColumn(1);
                    i++;
                    }
                    if (str[i] !== '=') this.error('INVALID_KEY_CHARACTER', 'Unexpected character ' + str[i] + ' expected `=`');
                    loc = 'value';
                    colnoBeginVal = this.colno + 1;
                    state = characterParser.defaultState();
                } else {
                    key += str[i]
                }
                break;
                case 'value':
                state = characterParser.parseChar(str[i], state);
                val += str[i];
                break;
            }
            }
            if (str[i] === '\n') {
            // Save the line number locally to keep this.lineno at the start of
            // the attribute.
            lineno++;
            this.colno = 1;
            // If the key has not been started, update this.lineno immediately.
            if (!key.trim()) this.lineno = lineno;
            } else if (str[i] !== undefined) {
            this.incrementColumn(1);
            }
        }

        // Reset the line numbers based on the line started on
        // plus the number of newline characters encountered
        this.lineno = startingLine + (str.match(/\n/g) || []).length;

        this.tokens.push(this.tok('end-attributes'));
        this.incrementColumn(1);
        return true;
        }
    },

    /**
     * &attributes block
     */
    attributesBlock: function () {
        if (/^&attributes\b/.test(this.input)) {
        let consumed = 11;
        this.consume(consumed);
        let tok = this.tok('&attributes');
        this.incrementColumn(consumed);
        let args = this.bracketExpression();
        consumed = args.end + 1;
        this.consume(consumed);
        tok.val = args.src;
        this.tokens.push(tok);
        this.incrementColumn(consumed);
        return true;
        }
    },

    /**
     * Indent | Outdent | Newline.
     */

    indent: function() {
        let captures = this.scanIndentation();

        if (captures) {
        let indents = captures[1].length;

        this.incrementLine(1);
        this.consume(indents + 1);

        if (' ' == this.input[0] || '\t' == this.input[0]) {
            this.error('INVALID_INDENTATION', 'Invalid indentation, you can use tabs or spaces but not both');
        }

        // blank line
        if ('\n' == this.input[0]) {
            this.interpolationAllowed = true;
            return this.tok('newline');
        }

        // outdent
        if (indents < this.indentStack[0]) {
            while (this.indentStack[0] > indents) {
            if (this.indentStack[1] < indents) {
                this.error('INCONSISTENT_INDENTATION', 'Inconsistent indentation. Expecting either ' + this.indentStack[1] + ' or ' + this.indentStack[0] + ' spaces/tabs.');
            }
            this.colno = this.indentStack[1] + 1;
            this.tokens.push(this.tok('outdent'));
            this.indentStack.shift();
            }
        // indent
        } else if (indents && indents != this.indentStack[0]) {
            this.tokens.push(this.tok('indent', indents));
            this.colno = 1 + indents;
            this.indentStack.unshift(indents);
        // newline
        } else {
            this.tokens.push(this.tok('newline'));
            this.colno = 1 + (this.indentStack[0] || 0);
        }

        this.interpolationAllowed = true;
        return true;
        }
    },

    pipelessText: function pipelessText(indents) {
        while (this.callLexerFunction('blank'));

        let captures = this.scanIndentation();

        indents = indents || captures && captures[1].length;
        if (indents > this.indentStack[0]) {
        this.tokens.push(this.tok('start-pipeless-text'));
        let tokens = [];
        let isMatch;
        // Index in this.input. Can't use this.consume because we might need to
        // retry lexing the block.
        let stringPtr = 0;
        do {
            // text has `\n` as a prefix
            let i = this.input.substr(stringPtr + 1).indexOf('\n');
            if (-1 == i) i = this.input.length - stringPtr - 1;
            let str = this.input.substr(stringPtr + 1, i);
            let lineCaptures = this.indentRe.exec('\n' + str);
            let lineIndents = lineCaptures && lineCaptures[1].length;
            isMatch = lineIndents >= indents || !str.trim();
            if (isMatch) {
            // consume test along with `\n` prefix if match
            stringPtr += str.length + 1;
            tokens.push(str.substr(indents));
            } else if (lineIndents > this.indentStack[0]) {
            // line is indented less than the first line but is still indented
            // need to retry lexing the text block
            this.tokens.pop();
            return pipelessText.call(this, lineCaptures[1].length);
            }
        } while((this.input.length - stringPtr) && isMatch);
        this.consume(stringPtr);
        while (this.input.length === 0 && tokens[tokens.length - 1] === '') tokens.pop();
        tokens.forEach(function (token, i) {
            this.incrementLine(1);
            if (i !== 0) this.tokens.push(this.tok('newline'));
            this.incrementColumn(indents);
            this.addText('text', token);
        }.bind(this));
        this.tokens.push(this.tok('end-pipeless-text'));
        return true;
        }
    },

    /**
     * Slash.
     */

    slash: function() {
        let tok = this.scan(/^\//, 'slash');
        if (tok) {
        this.tokens.push(tok);
        return true;
        }
    },

    /**
     * ':'
     */

    colon: function() {
        let tok = this.scan(/^: +/, ':');
        if (tok) {
        this.tokens.push(tok);
        return true;
        }
    },

    fail: function () {
        this.error('UNEXPECTED_TEXT', 'unexpected text "' + this.input.substr(0, 5) + '"');
    },

    callLexerFunction: function (func) {
        let rest = [];
        for (let i = 1; i < arguments.length; i++) {
        rest.push(arguments[i]);
        }
        let pluginArgs = [this].concat(rest);
        for (let i = 0; i < this.plugins.length; i++) {
        let plugin = this.plugins[i];
        if (plugin[func] && plugin[func].apply(plugin, pluginArgs)) {
            return true;
        }
        }
        return this[func].apply(this, rest);
    },

    /**
     * Move to the next token
     *
     * @api private
     */

    advance: function() {
        return this.callLexerFunction('blank')
        || this.callLexerFunction('eos')
        || this.callLexerFunction('endInterpolation')
        || this.callLexerFunction('yield')
        || this.callLexerFunction('doctype')
        || this.callLexerFunction('interpolation')
        || this.callLexerFunction('case')
        || this.callLexerFunction('when')
        || this.callLexerFunction('default')
        || this.callLexerFunction('extends')
        || this.callLexerFunction('append')
        || this.callLexerFunction('prepend')
        || this.callLexerFunction('block')
        || this.callLexerFunction('mixinBlock')
        || this.callLexerFunction('include')
        || this.callLexerFunction('mixin')
        || this.callLexerFunction('call')
        || this.callLexerFunction('conditional')
        || this.callLexerFunction('each')
        || this.callLexerFunction('while')
        || this.callLexerFunction('tag')
        || this.callLexerFunction('filter')
        || this.callLexerFunction('blockCode')
        || this.callLexerFunction('code')
        || this.callLexerFunction('id')
        || this.callLexerFunction('dot')
        || this.callLexerFunction('className')
        || this.callLexerFunction('attrs')
        || this.callLexerFunction('attributesBlock')
        || this.callLexerFunction('indent')
        || this.callLexerFunction('text')
        || this.callLexerFunction('textHtml')
        || this.callLexerFunction('comment')
        || this.callLexerFunction('slash')
        || this.callLexerFunction('colon')
        || this.fail();
    },

    /**
     * Return an array of tokens for the current file
     *
     * @returns {Array.<Token>}
     * @api public
     */
    getTokens: function () {
        while (!this.ended) {
        this.callLexerFunction('advance');
        }
        return this.tokens;
    }
    };

    pug_lexer = module.exports;
}
{
    let module = {exports:{}};
    var acorn = require('acorn');
    var objectAssign = require('object-assign');

    module.exports = isExpression;

    var DEFAULT_OPTIONS = {
    throw: false,
    strict: false,
    lineComment: false
    };

    function isExpression(src, options) {
    options = objectAssign({}, DEFAULT_OPTIONS, options);

    try {
        var parser = new acorn.Parser(options, src, 0);

        if (options.strict) {
        parser.strict = true;
        }

        if (!options.lineComment) {
        parser.skipLineComment = function (startSkip) {
            this.raise(this.pos, 'Line comments not allowed in an expression');
        };
        }

        parser.nextToken();
        parser.parseExpression();

        if (parser.type !== acorn.tokTypes.eof) {
        parser.unexpected();
        }
    } catch (ex) {
        if (!options.throw) {
        return false;
        }

        throw ex;
    }

    return true;
    }
    is_expression = module.exports;
}