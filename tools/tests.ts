import { expect } from 'chai';
import Ajv from 'ajv';
import * as url from 'url';
import path from 'path';
import fs from 'fs';
import { promisify } from 'util';
import { getLanguageService } from 'vscode-json-languageservice';
import { TextDocument } from 'vscode-languageserver-types';
import draft4MetaSchema from 'ajv/lib/refs/json-schema-draft-04.json';
import * as schemaTestsRunner from './schemaTestsRunner';
import 'mocha';

const readdir = promisify(fs.readdir);
const readFile = promisify(fs.readFile);
const stat = promisify(fs.stat);

const schemasFolder = __dirname + '/../schemas/';
const schemaTestsFolder = __dirname + '/../tests/';
const testSchemasFolder = __dirname + '/schemas/';
const templateTestsFolder = __dirname + '/templateTests/';
const armSchemasPrefix = /^https?:\/\/schema\.management\.azure\.com\/schemas\//
const jsonSchemaDraft4Prefix = /^https?:\/\/json-schema\.org\/draft-04\/schema/

const ajvInstance = new Ajv({
    loadSchema: loadSchema,
    strictDefaults: true,
    schemaId: 'id',
    meta: false
    }).addMetaSchema(draft4MetaSchema)
    .addFormat('int32',  /.*/)
    .addFormat('duration',  /.*/)
    .addFormat('password',  /.*/);

async function loadRawSchema(uri: string) : Promise<string> {
    const hashIndex = uri.indexOf("#");
    if (hashIndex !== -1) {
        uri = uri.substring(0, hashIndex);
    }

    let jsonPath : string;
    if (uri.match(armSchemasPrefix)) {
        jsonPath = uri.replace(armSchemasPrefix, schemasFolder);
    }
    else if (uri.match(jsonSchemaDraft4Prefix)) {
        return JSON.stringify(draft4MetaSchema);
    }
    else {
        jsonPath = uri;
    }

    if (jsonPath.startsWith("http:") || jsonPath.startsWith("https:")) {
        throw new Error(`Unsupported JSON path ${jsonPath}`);
    }

    return await readFile(jsonPath, { encoding: "utf8" });
}

async function loadSchema(uri: string) : Promise<object> {
    const rawSchema = await loadRawSchema(uri);
    return JSON.parse(stripUtf8Bom(rawSchema));
}

function stripUtf8Bom(value: string) {
    return value ? value.replace(/^\uFEFF/, '') : value;
}

async function listSchemaPaths(basePath: string, fileFilter: (path: string) => boolean): Promise<string[]> {
    let results: string[] = [];

    for (const subPathName of await readdir(basePath)) {
        const subPath = path.resolve(`${basePath}/${subPathName}`);

        const fileStat = await stat(subPath);
        if (fileStat.isDirectory()) {
            const pathResults = await listSchemaPaths(subPath, fileFilter);
            results = results.concat(pathResults);
            continue;
        }

        if (!fileStat.isFile()) {
            continue;
        }

        if (!fileFilter(subPath)) {
            continue;
        }

        results.push(subPath);
    }

    return results;
}

async function tryCompileSchema(schemaPath: string) {
    try {
        const schema = await loadSchema(schemaPath);

        // precompile schemas to add to cache
        await ajvInstance.compileAsync(schema);
    }
    catch {
        // ignore errors - want this to be caught in tests
    }
}

const rootSchemaPaths = [
    'https://schema.management.azure.com/schemas/2014-04-01-preview/deploymentTemplate.json',
    'https://schema.management.azure.com/schemas/2015-01-01/deploymentTemplate.json',
    'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json',
    'https://schema.management.azure.com/schemas/2019-03-01-hybrid/deploymentTemplate.json',
];

const metaSchemaPaths = [
    'http://json-schema.org/draft-04/schema',
    testSchemasFolder + 'ResourceMetaSchema.json',
];

const schemasToSkip = [
    '0.0.1-preview/CreateUIDefinition.CommonControl.json',
    '0.0.1-preview/CreateUIDefinition.MultiVm.json',
    '0.0.1-preview/CreateUIDefinition.ProviderControl.json',
    '0.1.0-preview/CreateUIDefinition.CommonControl.json',
    '0.1.0-preview/CreateUIDefinition.MultiVm.json',
    '0.1.0-preview/CreateUIDefinition.ProviderControl.json',
    '0.1.1-preview/CreateUIDefinition.CommonControl.json',
    '0.1.1-preview/CreateUIDefinition.MultiVm.json',
    '0.1.1-preview/CreateUIDefinition.ProviderControl.json',
    '0.1.2-preview/CreateUIDefinition.CommonControl.json',
    '0.1.2-preview/CreateUIDefinition.MultiVm.json',
    '0.1.2-preview/CreateUIDefinition.ProviderControl.json',
    '2014-04-01-preview/deploymentParameters.json',
    '2014-04-01-preview/deploymentTemplate.json',
    '2015-01-01/deploymentParameters.json',
    '2015-01-01/deploymentTemplate.json',
    '2015-10-01-preview/policyDefinition.json',
    '2016-12-01/policyDefinition.json',
    '2018-05-01/policyDefinition.json',
    '2018-05-01/subscriptionDeploymentParameters.json',
    '2018-05-01/subscriptionDeploymentTemplate.json',
    '2019-04-01/autogeneratedResources.json',
    '2019-04-01/deploymentParameters.json',
    '2019-04-01/deploymentTemplate.json',
    '2019-03-01-hybrid/deploymentTemplate.json',
    '2019-03-01-hybrid/deploymentParameters.json',
    '2019-08-01/managementGroupDeploymentParameters.json',
    '2019-08-01/managementGroupDeploymentTemplate.json',
    '2019-08-01/tenantDeploymentParameters.json',
    '2019-08-01/tenantDeploymentTemplate.json',
    'common/definitions.json',
    'common/manuallyAddedResources.json',
    'common/autogeneratedResources.json',
    'viewdefinition/0.0.1-preview/ViewDefinition.json',
].map(p => path.resolve(`${schemasFolder}/${p}`));

(async () => {
    const schemaPaths = await listSchemaPaths(schemasFolder, path => path.endsWith('.json') && schemasToSkip.indexOf(path) == -1);
    const schemaTestPaths = await listSchemaPaths(schemaTestsFolder, path => path.endsWith('.tests.json'));
    schemaTestPaths.push(testSchemasFolder + 'ResourceMetaSchema.tests.json');
    const templateTestPaths = await listSchemaPaths(templateTestsFolder, path => path.endsWith('.json'));

    const schemaTestMap: {[path: string]: any} = {};
    for (const testPath of schemaTestPaths) {
        const contents = await readFile(testPath, { encoding: 'utf8' });
        const data = JSON.parse(contents);

        schemaTestMap[testPath] = data;
    }

    for (const schemaPath of rootSchemaPaths) {
        await tryCompileSchema(schemaPath);
    }

    for (const schemaPath of metaSchemaPaths) {
        await tryCompileSchema(schemaPath);
    }

    describe('Root schemas can be compiled', () => {
        for (const schemaPath of rootSchemaPaths) {
            it(schemaPath, async function() {
                this.timeout(120000);
                
                const schema = await loadSchema(schemaPath);

                await ajvInstance.compileAsync(schema);
            });
        }
    });

    describe('Meta-schemas can be compiled', () => {
        for (const schemaPath of metaSchemaPaths) {
            it(schemaPath, async function() {
                this.timeout(120000);
                
                const schema = await loadSchema(schemaPath);

                await ajvInstance.compileAsync(schema);
            });
        }
    });

    describe('Validate resource schemas against meta-schemas', () => {
        for (const schemaPath of schemaPaths) {
            describe(schemaPath, () => {
                for (const metaSchemaPath of metaSchemaPaths) {
                    it(`Validate against '${metaSchemaPath}'`, async function() {
                        this.timeout(60000);
                        const schema = await loadSchema(schemaPath);
                        const metaSchema = await loadSchema(metaSchemaPath);
     
                        const validate = await ajvInstance.compileAsync(metaSchema);
                        const result = await validate(schema);

                        expect(result, `Validation failed with errors ${JSON.stringify(ajvInstance.errors, null, 2)}`).to.be.true;
                    });
                }
            });
        }
    });

    describe('Run individual schema test', () => {
        for (const testPath of schemaTestPaths) {
            describe(testPath, () => {
                for (const test of schemaTestMap[testPath].tests) {
                    it(test.name, async function() {
                        this.timeout(10000);

                        await schemaTestsRunner.execute(test, loadSchema);
                    });
                }
            });
        }
    });

    describe('Validate test templates against VSCode language service', () => {
        for (const templateTestFile of templateTestPaths) {
            it(`running schema validation on '${templateTestFile}'`, async function() {
                this.timeout(30000);

                const service = getLanguageService({
                    schemaRequestService: loadRawSchema,
                    workspaceContext: { 
                        resolveRelativePath: (relativePath, resource) => url.resolve(resource, relativePath)
                    },
                });

                const content = await readFile(templateTestFile, { encoding: 'utf8' });
                const textDocument = TextDocument.create(templateTestFile, 'json', 0, content);
                const jsonDocument = service.parseJSONDocument(textDocument);
            
                const result = await service.doValidation(textDocument, jsonDocument);
                expect(result).to.deep.equal([]);
            });
        }
    });

    run();
})();