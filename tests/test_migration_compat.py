import unittest
from unittest.mock import MagicMock

from api.migrations._sqlite_compat import add_column_if_missing


class AddColumnIfMissingTests(unittest.TestCase):
    def _mysql_connection(self):
        connection = MagicMock()
        connection.vendor = 'mysql'
        cursor = connection.cursor.return_value.__enter__.return_value
        cursor.fetchone.return_value = (0,)
        return connection, cursor

    def test_mysql_column_ddl_with_column_name_is_not_duplicated(self):
        connection, cursor = self._mysql_connection()

        add_column_if_missing(
            connection,
            'chat_messages',
            'is_pinned',
            '`is_pinned` TINYINT(1) NOT NULL DEFAULT 0',
        )

        self.assertEqual(
            cursor.execute.call_args_list[-1].args[0],
            'ALTER TABLE `chat_messages` ADD COLUMN `is_pinned` TINYINT(1) NOT NULL DEFAULT 0',
        )

    def test_mysql_type_only_definition_is_preserved(self):
        connection, cursor = self._mysql_connection()

        add_column_if_missing(
            connection,
            'attendance_corrections',
            'kind',
            "VARCHAR(20) NOT NULL DEFAULT ''",
        )

        self.assertEqual(
            cursor.execute.call_args_list[-1].args[0],
            "ALTER TABLE `attendance_corrections` ADD COLUMN `kind` VARCHAR(20) NOT NULL DEFAULT ''",
        )


if __name__ == '__main__':
    unittest.main()
