import * as ts from 'typescript';
import * as path from 'path';

const indexJs = path.join(__dirname, 'index.js');
const indexTs = path.join(__dirname, 'index.d.ts');

const isToDatesImportExpression = (node: ts.Node): node is ts.ImportDeclaration => {
    if (!ts.isImportDeclaration(node)) {
        return false;
    }
    const module = (node.moduleSpecifier as ts.StringLiteral).text;
    try {
        const modulePath = module.startsWith('.')
            ? require.resolve(path.resolve(path.dirname(node.getSourceFile().fileName), module))
            : require.resolve(module);
        return indexJs === modulePath;
    } catch (e) {
        return false;
    }
};

const isToDatesCallExpression = (node: ts.Node, typeChecker: ts.TypeChecker): node is ts.CallExpression => {
    if (!ts.isCallExpression(node)) return false;

    const signature = typeChecker.getResolvedSignature(node);
    if (typeof signature === 'undefined') {
        return false;
    }

    const { declaration } = signature;

    return (
        !!declaration &&
        !ts.isJSDocSignature(declaration) &&
        path.join(declaration.getSourceFile().fileName) === indexTs &&
        !!declaration.name &&
        declaration.name.getText() === 'toDates'
    );
};

function unbox(typeNode: ts.TypeNode) {
    while (ts.isArrayTypeNode(typeNode)) {
        typeNode = (typeNode as ts.ArrayTypeNode).elementType;
    }
    return typeNode;
}

function convertDates(
    type: ts.Type,
    typeChecker: ts.TypeChecker,
    prefix: ts.StringLiteral[],
    node: ts.Node
): ts.ArrayLiteralExpression[] {
    const properties = typeChecker.getPropertiesOfType(type);
    const getTypeOfProperty = (property: ts.Symbol) => {
        const propertyType = unbox((property.valueDeclaration as ts.PropertyDeclaration)?.type as ts.TypeNode);
        return typeChecker.getTypeFromTypeNode(propertyType).getNonNullableType();
    };
    return properties
        .reduce((props, property) => {
            const propertyType = getTypeOfProperty(property);
            if (typeChecker.typeToString(propertyType) === 'Date') {
                return props.concat(ts.createArrayLiteral(prefix.concat([ts.createLiteral(property.getName())]))); 
            }
            if (propertyType.isClassOrInterface()) {
                return props.concat(
                    convertDates(
                        propertyType,
                        typeChecker,
                        prefix.concat(ts.createStringLiteral(property.getName())),
                        node
                    )
                );
            }
            return props;
        }, [] as ts.ArrayLiteralExpression[]);
}

export default function transformer(program: ts.Program): ts.TransformerFactory<ts.SourceFile> {
    const typeChecker = program.getTypeChecker();
    const transformerDates = ts.createUniqueName('transformerDates');
    const toDatesByArray = ts.createIdentifier('toDatesByArray');

    return (context: ts.TransformationContext) => {
        const visit: ts.Visitor = (node: ts.Node) => {
            if (isToDatesImportExpression(node)) {
                const importNode = ts.createVariableStatement(undefined, [
                    ts.createVariableDeclaration(
                        transformerDates,
                        undefined,
                        ts.createCall(ts.createIdentifier('require'), undefined, [
                            ts.createLiteral('ts-transformer-dates')
                        ])
                    )
                ]);
                return importNode;
            }

            if (isToDatesCallExpression(node, typeChecker) && node.typeArguments) {
                const type = typeChecker.getTypeFromTypeNode(unbox(node.typeArguments[0]));
                const toDatesByArrayArgs = [
                    node.arguments[0],
                    ts.createArrayLiteral(convertDates(type, typeChecker, [], node))
                ];
                if (node.arguments.length > 1) toDatesByArrayArgs.push(node.arguments[1]);
                return ts.createCall(
                    ts.createPropertyAccess(transformerDates, toDatesByArray),
                    undefined,
                    toDatesByArrayArgs
                );
            }

            return ts.visitEachChild(node, child => visit(child), context);
        };

        return (node: ts.SourceFile) => ts.visitNode(node, visit);
    };
}
