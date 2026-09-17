"""Deterministic, reviewed translation of the frozen SQLite v0.5 migration.
Run explicitly from the repository root; normal application startup never runs it.
"""
from pathlib import Path
import hashlib,re,sqlite3
ROOT=Path(__file__).resolve().parents[2]
source=ROOT/'docs/engineering_v0.5/database/001_initial.sql'
text=source.read_text(); statements=[]; pending=''
for line in text.splitlines(True):
    if line.lstrip().startswith('--'): continue
    pending+=line
    if sqlite3.complete_statement(pending): statements.append(pending.strip()); pending=''
assert not pending.strip()

def expression(s):
    s=re.sub(r'\bINTEGER\b','BIGINT',s)
    s=s.replace(" NOT GLOB '*[^0-9a-f]*'", " !~ '[^0-9a-f]'")
    s=re.sub(r'\bjson_valid\(', 'lm_json_valid(', s)
    s=re.sub(r'\bjson_type\(', 'lm_json_type(', s)
    s=s.replace("instr(relative_output_path,'..')", "strpos(relative_output_path,'..')")
    def extract(m):
        result=f"({m[1]}::json ->> '{m[2]}')"
        return result+'::bigint' if m[2] in ['reportLimitPerRolePerScene','uploadLimitPerScene'] else result
    s=re.sub(r"json_extract\(([^,()]+),'\$\.([^']+)'\)",extract,s)
    s=re.sub(r'\bIS NOT (OLD\.\w+)',r'IS DISTINCT FROM \1',s)
    return s

helpers="""-- JSON remains TEXT: canonical bytes, hashes and immutable comparisons are preserved.
CREATE FUNCTION lm_json_valid(value TEXT) RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF value IS NULL THEN RETURN FALSE; END IF;
  PERFORM value::json;
  RETURN TRUE;
EXCEPTION WHEN invalid_text_representation THEN RETURN FALSE;
END;
$$;
CREATE FUNCTION lm_json_type(value TEXT) RETURNS TEXT LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE kind TEXT;
BEGIN
  kind := json_typeof(value::json);
  IF kind='string' THEN RETURN 'text'; END IF;
  IF kind='number' THEN
    IF value ~ '^\\s*-?[0-9]+\\s*$' THEN RETURN 'integer'; END IF;
    RETURN 'real';
  END IF;
  RETURN kind;
END;
$$;
"""
tables=[]; fks=[]; indexes=[]; triggers=[]; seed=[]
for s in statements:
    if s.startswith('CREATE TABLE'):
        m=re.fullmatch(r'CREATE TABLE (\w+) \(\n(.*)\n\) STRICT;',s,re.S); assert m,s
        table,body=m.groups(); lines=body.splitlines(); retained=[]
        for line in lines:
            stripped=line.strip().rstrip(',')
            if stripped.startswith('FOREIGN KEY'):
                fks.append(f'ALTER TABLE {table} ADD '+expression(stripped)+';')
                continue
            inline=re.search(r' REFERENCES (\w+)\(([^)]+)\)',line)
            if inline:
                col=stripped.split()[0]
                fks.append(f'ALTER TABLE {table} ADD FOREIGN KEY ({col}) REFERENCES {inline[1]}({inline[2]});')
                line=line[:inline.start()]+line[inline.end():]
            retained.append(line)
        body='\n'.join(retained).rstrip().rstrip(',')
        tables.append(f'CREATE TABLE {table} (\n'+expression(body)+'\n);')
    elif s.startswith('CREATE INDEX') or s.startswith('CREATE UNIQUE INDEX'):
        indexes.append(expression(s))
    elif s.startswith('CREATE TRIGGER'):
        m=re.fullmatch(r'CREATE TRIGGER (\w+) (BEFORE|AFTER) (INSERT|UPDATE|DELETE) ON (\w+)(?: WHEN (.*?))? BEGIN\s*(.*?)\s*END;',s,re.S)
        assert m,s
        name,timing,event,table,when,body=m.groups(); lines=[]
        for part in body.split(';'):
            part=part.strip()
            if not part:continue
            conditional=re.fullmatch(r"SELECT CASE WHEN (.*?) THEN RAISE\(ABORT,'([^']+)'\) END",part,re.S)
            unconditional=re.fullmatch(r"SELECT RAISE\(ABORT,'([^']+)'\)",part,re.S)
            if conditional:
                lines.append(f"  IF {expression(conditional[1])} THEN\n    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='{conditional[2]}';\n  END IF;")
            elif unconditional:
                lines.append(f"  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='{unconditional[1]}';")
            else:
                assert part.startswith('UPDATE '),part
                lines.append('  '+expression(part)+';')
        if when:
            # A function-level IF preserves subquery WHEN conditions, which PG's
            # CREATE TRIGGER WHEN cannot express. All original predicates retained.
            lines=['  IF '+expression(when)+' THEN']+['  '+x for x in lines]+['  END IF;']
        lines.append('  RETURN '+('OLD' if event=='DELETE' else 'NEW')+';')
        fname='lm_'+name
        assert len(fname)<64
        triggers.append(f'-- SQLite trigger: {name}\nCREATE FUNCTION {fname}() RETURNS TRIGGER LANGUAGE plpgsql AS $$\nBEGIN\n'+'\n'.join(lines)+f'\nEND;\n$$;\nCREATE TRIGGER {name} {timing} {event} ON {table}\nFOR EACH ROW EXECUTE FUNCTION {fname}();')
    elif s.startswith('INSERT INTO schema_migrations'):
        seed.append(s)
    else:
        assert s in ['PRAGMA foreign_keys=ON;','BEGIN IMMEDIATE;','PRAGMA user_version=1;','COMMIT;'],s
assert len(tables)==35 and len(triggers)==117
header=f'''-- LAST MILE PostgreSQL baseline, translated from the frozen SQLite v0.5 DDL.
-- Source SHA-256: {hashlib.sha256(source.read_bytes()).hexdigest()}
-- Reproduce: python3 tests/storage/generate-postgres.py
-- 35 baseline tables, 117 original triggers. Runtime/cloud tables are migration 002.
-- Applied in one transaction by createStore while holding the engine lease.
-- All foreign keys are added after table creation to support circular references;
-- the original DEFERRABLE INITIALLY DEFERRED clauses remain unchanged.
'''
result=header+'\n'+helpers+'\n\n'+'\n\n'.join(tables+fks+indexes+triggers+seed)+'\n'
assert 'json_extract(' not in result and 'RAISE(ABORT' not in result
(ROOT/'server/core/migrations/001_postgres.sql').write_text(result)
print('Generated 35 tables and 117 trigger functions')
