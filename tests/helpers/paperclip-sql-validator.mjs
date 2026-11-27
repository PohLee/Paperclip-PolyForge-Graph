// Runtime SQL validators from @paperclipai/server@2026.1106.0, dist/services/plugin-database.js.

// Keep this list aligned with database.coreReadTables in the Graph plugin manifest.
export const graphCoreReadTables = ['companies', 'issues', 'agents', 'heartbeat_runs'];

function splitSqlStatements(input) {
    const statements = [];
    let start = 0;
    let quote = null;
    let lineComment = false;
    let blockComment = false;
    for (let i = 0; i < input.length; i += 1) {
        const char = input[i];
        const next = input[i + 1];
        if (lineComment) {
            if (char === "\n")
                lineComment = false;
            continue;
        }
        if (blockComment) {
            if (char === "*" && next === "/") {
                blockComment = false;
                i += 1;
            }
            continue;
        }
        if (quote) {
            if (char === quote) {
                if (next === quote) {
                    i += 1;
                }
                else {
                    quote = null;
                }
            }
            continue;
        }
        if (char === "-" && next === "-") {
            lineComment = true;
            i += 1;
            continue;
        }
        if (char === "/" && next === "*") {
            blockComment = true;
            i += 1;
            continue;
        }
        if (char === "'" || char === "\"") {
            quote = char;
            continue;
        }
        if (char === ";") {
            const statement = input.slice(start, i).trim();
            if (statement)
                statements.push(statement);
            start = i + 1;
        }
    }
    const trailing = input.slice(start).trim();
    if (trailing)
        statements.push(trailing);
    return statements;
}
function stripSqlForKeywordScan(input) {
    return input
        .replace(/'([^']|'')*'/g, "''")
        .replace(/"([^"]|"")*"/g, "\"\"")
        .replace(/--.*$/gm, "")
        .replace(/\/\*[\s\S]*?\*\//g, "");
}
function normaliseSql(input) {
    return stripSqlForKeywordScan(input).replace(/\s+/g, " ").trim().toLowerCase();
}
function extractQualifiedRefs(statement) {
    const refs = [];
    const patterns = [
        {
            pattern: /\b(from|join|references|into|update)\s+"?([A-Za-z_][A-Za-z0-9_]*)"?\."?([A-Za-z_][A-Za-z0-9_]*)"?/gi,
            groups: "keyword-schema-table",
        },
        {
            pattern: /\b(alter\s+table|create\s+table|create\s+view|drop\s+table|truncate\s+table)\s+(?:if\s+(?:not\s+)?exists\s+)?"?([A-Za-z_][A-Za-z0-9_]*)"?\."?([A-Za-z_][A-Za-z0-9_]*)"?/gi,
            groups: "keyword-schema-table",
        },
        {
            pattern: /\bcreate\s+(?:unique\s+)?index(?:\s+concurrently)?\s+(?:if\s+not\s+exists\s+)?"?[A-Za-z_][A-Za-z0-9_]*"?\s+on\s+"?([A-Za-z_][A-Za-z0-9_]*)"?\."?([A-Za-z_][A-Za-z0-9_]*)"?/gi,
            groups: "schema-table",
            keyword: "create index",
        },
    ];
    for (const { pattern, ...mapping } of patterns) {
        for (const match of statement.matchAll(pattern)) {
            if (mapping.groups === "keyword-schema-table") {
                refs.push({ keyword: match[1].toLowerCase(), schema: match[2], table: match[3] });
            }
            else {
                refs.push({ keyword: mapping.keyword, schema: match[1], table: match[2] });
            }
        }
    }
    return refs;
}
function assertAllowedPublicRead(ref, allowedCoreReadTables) {
    if (ref.schema !== "public")
        return;
    if (!allowedCoreReadTables.has(ref.table)) {
        throw new Error(`Plugin SQL references public.${ref.table}, which is not whitelisted`);
    }
    if (!["from", "join", "references"].includes(ref.keyword)) {
        throw new Error(`Plugin SQL cannot mutate or define objects in public.${ref.table}`);
    }
}
function assertNoBannedSql(statement) {
    const normalized = normaliseSql(statement);
    const banned = [
        /\bcreate\s+extension\b/,
        /\bcreate\s+(?:event\s+)?trigger\b/,
        /\bcreate\s+(?:or\s+replace\s+)?function\b/,
        /\bcreate\s+language\b/,
        /\bgrant\b/,
        /\brevoke\b/,
        /\bsecurity\s+definer\b/,
        /\bcopy\b/,
        /\bcall\b/,
        /\bdo\s+(?:\$\$|language\b)/,
    ];
    const matched = banned.find((pattern) => pattern.test(normalized));
    if (matched) {
        throw new Error(`Plugin SQL contains a disallowed statement or clause: ${matched.source}`);
    }
}

export function validatePluginRuntimeQuery(query, namespace, coreReadTables = []) {
    const statements = splitSqlStatements(query);
    if (statements.length !== 1) {
        throw new Error("Plugin runtime SQL must contain exactly one statement");
    }
    const statement = statements[0];
    assertNoBannedSql(statement);
    const normalized = normaliseSql(statement);
    if (!normalized.startsWith("select ") && !normalized.startsWith("with ")) {
        throw new Error("ctx.db.query only allows SELECT statements");
    }
    if (/\b(insert|update|delete|alter|create|drop|truncate)\b/.test(normalized)) {
        throw new Error("ctx.db.query cannot contain mutation or DDL keywords");
    }
    const allowedCoreReadTables = new Set(coreReadTables);
    for (const ref of extractQualifiedRefs(statement)) {
        if (ref.schema === namespace)
            continue;
        if (ref.schema === "public") {
            assertAllowedPublicRead(ref, allowedCoreReadTables);
            continue;
        }
        throw new Error(`ctx.db.query cannot read schema "${ref.schema}"`);
    }
}
export function validatePluginRuntimeExecute(query, namespace) {
    const statements = splitSqlStatements(query);
    if (statements.length !== 1) {
        throw new Error("Plugin runtime SQL must contain exactly one statement");
    }
    const statement = statements[0];
    assertNoBannedSql(statement);
    const normalized = normaliseSql(statement);
    if (!/^(insert\s+into|update|delete\s+from)\b/.test(normalized)) {
        throw new Error("ctx.db.execute only allows INSERT, UPDATE, or DELETE");
    }
    if (/\b(alter|create|drop|truncate)\b/.test(normalized)) {
        throw new Error("ctx.db.execute cannot contain DDL keywords");
    }
    const refs = extractQualifiedRefs(statement);
    const target = refs.find((ref) => ["into", "update", "from"].includes(ref.keyword));
    if (!target || target.schema !== namespace) {
        throw new Error(`ctx.db.execute target must be inside plugin namespace "${namespace}"`);
    }
    for (const ref of refs) {
        if (ref.schema !== namespace) {
            throw new Error("ctx.db.execute cannot reference public or other non-plugin schemas");
        }
    }
}
