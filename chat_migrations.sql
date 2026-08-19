-- =============================================================================
-- HRMS — Employee Chat schema (direct messages, channels, meetings)
-- Run this against your HRMS MySQL/MariaDB database BEFORE restarting Django.
-- Every statement uses "IF NOT EXISTS", so it is safe to re-run and safe even
-- if you already created some of the chat tables by hand.
--
--   mysql -u <user> -p <your_db_name> < chat_migrations.sql
--
-- (Optionally uncomment the USE line below and set your database name.)
-- =============================================================================

-- USE `hrms_ai`;

-- -----------------------------------------------------------------------------
-- 1. chat_rooms — a conversation. is_group = 0 → direct 1:1, 1 → channel.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `chat_rooms` (
  `id`         INT AUTO_INCREMENT PRIMARY KEY,
  `name`       VARCHAR(255)  NOT NULL DEFAULT '',
  `is_group`   TINYINT(1)    NOT NULL DEFAULT 0,
  `created_by` VARCHAR(255)  NOT NULL DEFAULT '',
  `created_at` DATETIME      NULL,
  `is_private` TINYINT(1)    NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- 2. chat_members — which employees belong to which room.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `chat_members` (
  `id`             INT AUTO_INCREMENT PRIMARY KEY,
  `employee_email` VARCHAR(255) NOT NULL,
  `room_id`        INT          NOT NULL,
  `joined_at`      DATETIME     NULL,
  INDEX `chat_members_room_idx`  (`room_id`),
  INDEX `chat_members_email_idx` (`employee_email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- 3. chat_messages — one row per message.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `chat_messages` (
  `id`           INT AUTO_INCREMENT PRIMARY KEY,
  `sender_email` VARCHAR(255) NOT NULL,
  `sender_name`  VARCHAR(255) NOT NULL DEFAULT '',
  `room_id`      INT          NOT NULL,
  `message`      TEXT         NOT NULL,
  `is_read`      TINYINT(1)   NOT NULL DEFAULT 0,
  `created_at`   DATETIME     NULL,
  INDEX `chat_messages_room_idx` (`room_id`),
  INDEX `chat_messages_room_created_idx` (`room_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- 4. chat_meetings — scheduled meetings tied to a room, with a join link.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `chat_meetings` (
  `id`               INT AUTO_INCREMENT PRIMARY KEY,
  `room_id`          INT          NULL,
  `title`            VARCHAR(255) NOT NULL,
  `description`      TEXT         NULL,
  `scheduled_at`     DATETIME     NOT NULL,
  `duration_minutes` INT          NOT NULL DEFAULT 30,
  `created_by`       VARCHAR(255) NOT NULL DEFAULT '',
  `created_by_name`  VARCHAR(255) NOT NULL DEFAULT '',
  `join_url`         VARCHAR(512) NOT NULL DEFAULT '',
  `attendees`        TEXT         NULL,
  `created_at`       DATETIME     NULL,
  INDEX `chat_meetings_room_idx`  (`room_id`),
  INDEX `chat_meetings_when_idx`  (`scheduled_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =============================================================================
-- Done. Restart Django (or `touch passenger_wsgi.py` on cPanel) so the new
-- endpoints load. No `manage.py migrate` is needed — the chat models are
-- unmanaged (managed = False) and map directly onto these tables.
-- =============================================================================
