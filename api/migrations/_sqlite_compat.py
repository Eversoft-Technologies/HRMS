import re


def is_sqlite(connection):
    return getattr(connection, 'vendor', None) == 'sqlite'


def quote_identifier(name):
    return '"' + str(name).replace('"', '""') + '"'


def sqlite_ddl_for_mysql(ddl):
    text = str(ddl).strip()
    text = text.replace('`', '')
    text = re.sub(r'\bTINYINT\s*\(\s*1\s*\)\b', 'INTEGER', text, flags=re.I)
    text = re.sub(r'\bINT\b', 'INTEGER', text, flags=re.I)
    text = re.sub(r'\bDOUBLE\b', 'REAL', text, flags=re.I)
    text = re.sub(r'\bDATETIME\b', 'TEXT', text, flags=re.I)
    text = re.sub(r'\bTIMESTAMP\b', 'TEXT', text, flags=re.I)
    text = re.sub(r'\bLONGTEXT\b', 'TEXT', text, flags=re.I)
    text = re.sub(r'\bVARCHAR\s*\([^)]*\)\b', 'TEXT', text, flags=re.I)
    text = re.sub(r'\bCHAR\s*\([^)]*\)\b', 'TEXT', text, flags=re.I)
    text = re.sub(r'\bJSON\b', 'TEXT', text, flags=re.I)
    text = re.sub(r'\bBOOLEAN\b', 'INTEGER', text, flags=re.I)
    text = re.sub(r'\bBIT\b', 'INTEGER', text, flags=re.I)
    text = re.sub(r'\bSMALLINT\b', 'INTEGER', text, flags=re.I)
    text = re.sub(r'\bMEDIUMINT\b', 'INTEGER', text, flags=re.I)
    text = re.sub(r'\bBIGINT\b', 'INTEGER', text, flags=re.I)
    text = text.replace('NULL DEFAULT NULL', 'DEFAULT NULL')
    text = text.replace('NOT NULL DEFAULT NULL', 'DEFAULT NULL')
    return text


def table_exists(connection, table_name):
    if not is_sqlite(connection):
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = %s",
                [table_name],
            )
            return cursor.fetchone()[0] > 0

    with connection.cursor() as cursor:
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name = %s", [table_name])
        return cursor.fetchone() is not None


def column_exists(connection, table_name, column_name):
    if not is_sqlite(connection):
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT COUNT(*) FROM information_schema.COLUMNS
                 WHERE TABLE_SCHEMA = DATABASE()
                   AND TABLE_NAME = %s
                   AND COLUMN_NAME = %s
                """,
                [table_name, column_name],
            )
            return cursor.fetchone()[0] > 0

    with connection.cursor() as cursor:
        cursor.execute(f'PRAGMA table_info({quote_identifier(table_name)})')
        for row in cursor.fetchall():
            if row[1] == column_name:
                return True
    return False


def add_column_if_missing(connection, table_name, column_name, mysql_ddl):
    if column_exists(connection, table_name, column_name):
        return

    definition = str(mysql_ddl).strip()
    quoted_column = '`%s`' % column_name
    if definition.startswith(quoted_column):
        definition = definition[len(quoted_column):].lstrip()

    if is_sqlite(connection):
        ddl = sqlite_ddl_for_mysql(definition)
        with connection.cursor() as cursor:
            cursor.execute(
                f'ALTER TABLE {quote_identifier(table_name)} ADD COLUMN {quote_identifier(column_name)} {ddl}'
            )
        return

    with connection.cursor() as cursor:
        cursor.execute("ALTER TABLE `%s` ADD COLUMN `%s` %s" % (table_name, column_name, definition))
