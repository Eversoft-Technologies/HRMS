-- SQL Script to create Payroll Tables in MySQL / SQLite

ALTER TABLE `employee_attendance` ADD COLUMN `is_auto_checked_out` tinyint(1) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS `employee_compensation` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `email` varchar(255) NOT NULL,
  `pay_type` varchar(20) NOT NULL DEFAULT 'salaried',
  `pay_frequency` varchar(20) NOT NULL DEFAULT 'monthly',
  `base_amount` decimal(12,2) NOT NULL DEFAULT 0.00,
  `annual_ctc` decimal(12,2) NOT NULL DEFAULT 0.00,
  `currency` varchar(10) NOT NULL DEFAULT 'USD',
  `effective_from` date NOT NULL,
  `effective_to` date DEFAULT NULL,
  `status` varchar(20) NOT NULL DEFAULT 'active',
  `notes` longtext NOT NULL,
  `created_at` datetime(6) NOT NULL,
  `updated_at` datetime(6) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `employee_compensation_email_idx` (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `pay_components` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `code` varchar(50) NOT NULL UNIQUE,
  `name` varchar(100) NOT NULL,
  `component_type` varchar(20) NOT NULL DEFAULT 'earning',
  `calc_type` varchar(30) NOT NULL DEFAULT 'fixed',
  `rate` decimal(8,4) NOT NULL DEFAULT 0.0000,
  `default_amount` decimal(12,2) NOT NULL DEFAULT 0.00,
  `is_taxable` tinyint(1) NOT NULL DEFAULT 1,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `created_at` datetime(6) NOT NULL,
  `updated_at` datetime(6) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `employee_pay_components` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `email` varchar(255) NOT NULL,
  `component_id` bigint NOT NULL,
  `amount` decimal(12,2) DEFAULT NULL,
  `rate` decimal(8,4) DEFAULT NULL,
  `effective_from` date NOT NULL,
  `effective_to` date DEFAULT NULL,
  `created_at` datetime(6) NOT NULL,
  `updated_at` datetime(6) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `employee_pay_components_email_idx` (`email`),
  CONSTRAINT `fk_emp_pay_comp` FOREIGN KEY (`component_id`) REFERENCES `pay_components` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `payroll_runs` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `period_label` varchar(20) NOT NULL,
  `period_start` date NOT NULL,
  `period_end` date NOT NULL,
  `pay_date` date DEFAULT NULL,
  `frequency` varchar(20) NOT NULL DEFAULT 'monthly',
  `status` varchar(30) NOT NULL DEFAULT 'draft',
  `created_by` varchar(255) NOT NULL DEFAULT '',
  `approved_by` varchar(255) NOT NULL DEFAULT '',
  `approved_at` datetime(6) DEFAULT NULL,
  `total_gross` decimal(14,2) NOT NULL DEFAULT 0.00,
  `total_deductions` decimal(14,2) NOT NULL DEFAULT 0.00,
  `total_net` decimal(14,2) NOT NULL DEFAULT 0.00,
  `employee_count` int NOT NULL DEFAULT 0,
  `notes` longtext NOT NULL,
  `created_at` datetime(6) NOT NULL,
  `updated_at` datetime(6) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `payroll_runs_period_idx` (`period_label`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `payslips` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `run_id` bigint NOT NULL,
  `email` varchar(255) NOT NULL,
  `employee_name` varchar(255) NOT NULL DEFAULT '',
  `worked_days` decimal(5,2) NOT NULL DEFAULT 0.00,
  `paid_days` decimal(5,2) NOT NULL DEFAULT 0.00,
  `lop_days` decimal(5,2) NOT NULL DEFAULT 0.00,
  `overtime_hours` decimal(6,2) NOT NULL DEFAULT 0.00,
  `base_salary` decimal(12,2) NOT NULL DEFAULT 0.00,
  `gross_earnings` decimal(12,2) NOT NULL DEFAULT 0.00,
  `total_deductions` decimal(12,2) NOT NULL DEFAULT 0.00,
  `net_pay` decimal(12,2) NOT NULL DEFAULT 0.00,
  `earnings_data` json DEFAULT NULL,
  `deductions_data` json DEFAULT NULL,
  `status` varchar(20) NOT NULL DEFAULT 'draft',
  `file_name` varchar(255) NOT NULL DEFAULT '',
  `file_mime` varchar(100) NOT NULL DEFAULT 'application/pdf',
  `file_size` int NOT NULL DEFAULT 0,
  `file_data` longtext NOT NULL,
  `created_at` datetime(6) NOT NULL,
  `updated_at` datetime(6) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `payslips_run_email_uniq` (`run_id`, `email`),
  CONSTRAINT `fk_payslip_run` FOREIGN KEY (`run_id`) REFERENCES `payroll_runs` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `payroll_settings` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `key` varchar(100) NOT NULL UNIQUE,
  `value` longtext NOT NULL,
  `description` varchar(255) NOT NULL DEFAULT '',
  `updated_at` datetime(6) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
