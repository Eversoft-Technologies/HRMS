# Pure PowerShell / .NET PDF Generator for Junior Developer Git Guide
Add-Type -AssemblyName System.Drawing

$pdfPath = "C:\Users\SRIKANTH ADIPIREDDY\Desktop\Eversoft_hrms\HRMS\GITHUB_DAILY_WORKFLOW_GUIDE.pdf"

# Building PDF objects
$objects = [System.Collections.Generic.List[string]]::new()

function Add-PdfObject($content) {
    $objects.Add($content)
    return $objects.Count
}

# 1. Catalog & Pages structure
# We will construct a clean 2-page PDF

$page1Content = @"
BT
/F1 20 Tf
0.117 0.227 0.541 rg
40 780 Td
(Junior Developer's Daily Git & GitHub Guide) Tj
ET

BT
/F2 10 Tf
0.35 0.35 0.35 rg
40 762 Td
(A simple, step-by-step handbook with zero confusing jargon.) Tj
ET

% Divider
0.145 0.388 0.921 RG
2 w
40 752 m 555 752 l S

% Section: Simple Words
0.97 0.98 0.99 rg
0.8 0.85 0.9 RG
1 w
40 655 515 85 re B

BT
/F1 11 Tf
0.117 0.227 0.541 rg
52 725 Td
(What is Git & GitHub in Simple Words?) Tj
ET

BT
/F2 9.5 Tf
0.15 0.15 0.15 rg
52 708 Td
(- Your Local Code (Laptop): Your personal notebook where you write code.) Tj
0 -14 Td
(- Git: A camera that takes 'snapshots' (commits) of your work so you never lose progress.) Tj
0 -14 Td
(- GitHub (The Cloud): The shared online bookshelf where the team puts their snapshots.) Tj
0 -14 Td
(- Branch: A separate photocopy of the project to experiment without breaking main code.) Tj
ET

% 3 Golden Rules Box
1 0.98 0.92 rg
0.85 0.46 0.04 RG
1 w
40 560 515 80 re B

BT
/F1 11 Tf
0.7 0.25 0.02 rg
52 623 Td
(3 GOLDEN RULES (Never Break These!)) Tj
ET

BT
/F2 9.5 Tf
0.15 0.15 0.15 rg
52 605 Td
(1. NEVER write code directly on main - always create your own branch.) Tj
0 -15 Td
(2. PULL every morning - always start with the latest team updates.) Tj
0 -15 Td
(3. COMMIT often - think of it like pressing Ctrl + S at a video game checkpoint.) Tj
ET

% Daily Routine Heading
BT
/F1 14 Tf
0.117 0.227 0.541 rg
40 528 Td
(DAILY ROUTINE (Step-by-Step)) Tj
ET

% Step 1
BT
/F1 10.5 Tf
0.117 0.3 0.7 rg
40 505 Td
(Step 1: Morning Routine (9:00 AM) - Pull Latest Code) Tj
ET

0.06 0.09 0.16 rg
40 455 515 42 re f

BT
/F3 9 Tf
0.97 0.98 1 rg
50 482 Td
(git checkout main) Tj
0 -14 Td
(git pull origin main) Tj
ET

% Step 2
BT
/F1 10.5 Tf
0.117 0.3 0.7 rg
40 435 Td
(Step 2: Start a New Task - Create Your Branch) Tj
ET

0.06 0.09 0.16 rg
40 400 515 28 re f

BT
/F3 9 Tf
0.97 0.98 1 rg
50 412 Td
(git checkout -b feat/add-login-button) Tj
ET

% Step 3
BT
/F1 10.5 Tf
0.117 0.3 0.7 rg
40 380 Td
(Step 3: Save Your Checkpoints During the Day) Tj
ET

BT
/F2 9.5 Tf
0.15 0.15 0.15 rg
40 365 Td
(1. Check changed files:    git status) Tj
0 -14 Td
(2. Select files to save:    git add .   OR   git add path/to/file.py) Tj
0 -14 Td
(3. Save your snapshot:     git commit -m "Add validation for employee login") Tj
ET

0.06 0.09 0.16 rg
40 280 515 42 re f

BT
/F3 9 Tf
0.97 0.98 1 rg
50 307 Td
(git add .) Tj
0 -14 Td
(git commit -m "Add validation for employee login") Tj
ET

% Step 4
BT
/F1 10.5 Tf
0.117 0.3 0.7 rg
40 258 Td
(Step 4: End of Day - Push to GitHub & Open PR) Tj
ET

0.06 0.09 0.16 rg
40 222 515 28 re f

BT
/F3 9 Tf
0.97 0.98 1 rg
50 234 Td
(git push -u origin feat/add-login-button) Tj
ET

BT
/F2 9.5 Tf
0.15 0.15 0.15 rg
40 206 Td
(Then open GitHub.com -> Click 'Compare & pull request' -> Add title & submit!) Tj
ET

% Step 5
BT
/F1 10.5 Tf
0.117 0.3 0.7 rg
40 182 Td
(Step 5: Post-Merge Cleanup (When your PR is merged)) Tj
ET

0.06 0.09 0.16 rg
40 132 515 42 re f

BT
/F3 9 Tf
0.97 0.98 1 rg
50 159 Td
(git checkout main && git pull origin main) Tj
0 -14 Td
(git branch -d feat/add-login-button) Tj
ET

% Page 1 Footer
0.8 0.8 0.8 RG
0.5 w
40 60 m 555 60 l S

BT
/F2 8.5 Tf
0.5 0.5 0.5 rg
40 45 Td
(Eversoft HRMS Developer Guide) Tj
450 0 Td
(Page 1 of 2) Tj
ET
"@

$page2Content = @"
BT
/F1 16 Tf
0.117 0.227 0.541 rg
40 780 Td
(Emergency Help & Quick Cheat Sheet) Tj
ET

% Divider
0.145 0.388 0.921 RG
2 w
40 770 m 555 770 l S

% Emergency Q&A Box
0.98 0.98 0.99 rg
0.8 0.85 0.9 RG
1 w
40 515 515 235 re B

BT
/F1 11 Tf
0.8 0.1 0.1 rg
52 732 Td
(Emergency FAQ: "I'm Stuck! What Do I Do?") Tj
ET

BT
/F1 9.5 Tf
0.1 0.1 0.1 rg
52 712 Td
(Q: I don't know what branch I am on!) Tj
ET
BT
/F3 9 Tf
0.1 0.4 0.1 rg
52 698 Td
(   -> Run: git branch     (The green one with * is your current branch)) Tj
ET

BT
/F1 9.5 Tf
0.1 0.1 0.1 rg
52 678 Td
(Q: I made a mess and want to undo all unsaved changes!) Tj
ET
BT
/F3 9 Tf
0.1 0.4 0.1 rg
52 664 Td
(   -> Run: git restore .) Tj
ET

BT
/F1 9.5 Tf
0.1 0.1 0.1 rg
52 644 Td
(Q: I need to switch branch quickly without losing uncommitted code!) Tj
ET
BT
/F3 9 Tf
0.1 0.4 0.1 rg
52 630 Td
(   -> Run: git stash        (Then later: git stash pop)) Tj
ET

BT
/F1 9.5 Tf
0.1 0.1 0.1 rg
52 610 Td
(Q: Git opened a black screen (Vim editor) and I cannot exit!) Tj
ET
BT
/F3 9 Tf
0.1 0.4 0.1 rg
52 596 Td
(   -> Press [Esc] key, then type :wq and press [Enter]) Tj
ET

BT
/F1 9.5 Tf
0.1 0.1 0.1 rg
52 576 Td
(Q: I accidentally started working on 'main' branch!) Tj
ET
BT
/F3 9 Tf
0.1 0.4 0.1 rg
52 562 Td
(   -> Run: git checkout -b feat/my-task-name    (Moves your changes to new branch)) Tj
ET

% Cheat Sheet Heading
BT
/F1 13 Tf
0.117 0.227 0.541 rg
40 480 Td
(DAILY COMMAND CHEAT SHEET) Tj
ET

% Table Header
0.117 0.25 0.68 rg
40 445 515 22 re f

BT
/F1 9.5 Tf
1 1 1 rg
50 452 Td
(ACTION) Tj
130 0 Td
(COMMAND TO RUN) Tj
210 0 Td
(WHEN TO USE) Tj
ET

% Table Rows
0.95 0.96 0.98 rg
40 415 515 28 re f

BT
/F1 9 Tf
0.1 0.1 0.1 rg
50 427 Td
(Check Status) Tj
ET
BT
/F3 8.5 Tf
0.1 0.2 0.7 rg
180 427 Td
(git status) Tj
ET
BT
/F2 8.5 Tf
0.2 0.2 0.2 rg
390 427 Td
(See all changed / unstaged files) Tj
ET

0.117 0.25 0.68 rg
0.2 w
40 415 m 555 415 l S

0.98 0.98 0.99 rg
40 385 515 28 re f

BT
/F1 9 Tf
0.1 0.1 0.1 rg
50 397 Td
(Get Latest) Tj
ET
BT
/F3 8.5 Tf
0.1 0.2 0.7 rg
180 397 Td
(git checkout main && git pull) Tj
ET
BT
/F2 8.5 Tf
0.2 0.2 0.2 rg
390 397 Td
(Every morning before starting work) Tj
ET

0.117 0.25 0.68 rg
0.2 w
40 385 m 555 385 l S

0.95 0.96 0.98 rg
40 355 515 28 re f

BT
/F1 9 Tf
0.1 0.1 0.1 rg
50 367 Td
(New Task) Tj
ET
BT
/F3 8.5 Tf
0.1 0.2 0.7 rg
180 367 Td
(git checkout -b feat/task-name) Tj
ET
BT
/F2 8.5 Tf
0.2 0.2 0.2 rg
390 367 Td
(Before writing any new code) Tj
ET

0.117 0.25 0.68 rg
0.2 w
40 355 m 555 355 l S

0.98 0.98 0.99 rg
40 325 515 28 re f

BT
/F1 9 Tf
0.1 0.1 0.1 rg
50 337 Td
(Save Progress) Tj
ET
BT
/F3 8.5 Tf
0.1 0.2 0.7 rg
180 337 Td
(git add . && git commit -m "...") Tj
ET
BT
/F2 8.5 Tf
0.2 0.2 0.2 rg
390 337 Td
(After finishing a logical piece) Tj
ET

0.117 0.25 0.68 rg
0.2 w
40 325 m 555 325 l S

0.95 0.96 0.98 rg
40 295 515 28 re f

BT
/F1 9 Tf
0.1 0.1 0.1 rg
50 307 Td
(Push Work) Tj
ET
BT
/F3 8.5 Tf
0.1 0.2 0.7 rg
180 307 Td
(git push -u origin feat/task-name) Tj
ET
BT
/F2 8.5 Tf
0.2 0.2 0.2 rg
390 307 Td
(When task is ready for review) Tj
ET

0.117 0.25 0.68 rg
0.2 w
40 295 m 555 295 l S

0.98 0.98 0.99 rg
40 265 515 28 re f

BT
/F1 9 Tf
0.1 0.1 0.1 rg
50 277 Td
(Clean Old Branch) Tj
ET
BT
/F3 8.5 Tf
0.1 0.2 0.7 rg
180 277 Td
(git branch -d feat/task-name) Tj
ET
BT
/F2 8.5 Tf
0.2 0.2 0.2 rg
390 277 Td
(After PR is merged into main) Tj
ET

% Summary Quote
0.93 0.97 1 rg
0.2 0.5 0.9 RG
1 w
40 180 515 55 re B

BT
/F1 10 Tf
0.117 0.3 0.7 rg
52 215 Td
(Key Takeaway for Every Junior Developer:) Tj
ET
BT
/F2 9 Tf
0.2 0.2 0.2 rg
52 198 Td
("Git is your safety net. You cannot break production as long as you work on your own branch) Tj
0 -12 Td
(and submit Pull Requests for review. Happy coding!") Tj
ET

% Page 2 Footer
0.8 0.8 0.8 RG
0.5 w
40 60 m 555 60 l S

BT
/F2 8.5 Tf
0.5 0.5 0.5 rg
40 45 Td
(Eversoft HRMS Developer Guide) Tj
450 0 Td
(Page 2 of 2) Tj
ET
"@

# Helper to build raw PDF file
$p1Len = [System.Text.Encoding]::ASCII.GetByteCount($page1Content)
$p2Len = [System.Text.Encoding]::ASCII.GetByteCount($page2Content)

$pdfRaw = @"
%PDF-1.4
1 0 obj
<<
  /Type /Catalog
  /Pages 2 0 R
>>
endobj
2 0 obj
<<
  /Type /Pages
  /Kids [3 0 R 4 0 R]
  /Count 2
>>
endobj
3 0 obj
<<
  /Type /Page
  /Parent 2 0 R
  /MediaBox [0 0 595 842]
  /Contents 5 0 R
  /Resources <<
    /Font <<
      /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>
      /F2 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
      /F3 << /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold >>
    >>
  >>
>>
endobj
4 0 obj
<<
  /Type /Page
  /Parent 2 0 R
  /MediaBox [0 0 595 842]
  /Contents 6 0 R
  /Resources <<
    /Font <<
      /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>
      /F2 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
      /F3 << /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold >>
    >>
  >>
>>
endobj
5 0 obj
<<
  /Length $p1Len
>>
stream
$page1Content
endstream
endobj
6 0 obj
<<
  /Length $p2Len
>>
stream
$page2Content
endstream
endobj
xref
0 7
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000300 00000 n 
0000000485 00000 n 
0000000550 00000 n 
trailer
<<
  /Size 7
  /Root 1 0 R
>>
startxref
700
%%EOF
"@

[System.IO.File]::WriteAllText($pdfPath, $pdfRaw, [System.Text.Encoding]::ASCII)
Write-Host "PDF Generated at $pdfPath"
