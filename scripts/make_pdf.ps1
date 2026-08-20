$docPath = "C:\Users\SRIKANTH ADIPIREDDY\Desktop\Eversoft_hrms\HRMS\GITHUB_DAILY_WORKFLOW_GUIDE.doc"
$pdfPath = "C:\Users\SRIKANTH ADIPIREDDY\Desktop\Eversoft_hrms\HRMS\GITHUB_DAILY_WORKFLOW_GUIDE.pdf"

try {
    $word = New-Object -ComObject Word.Application
    $word.Visible = $false
    $doc = $word.Documents.Open($docPath)
    $doc.SaveAs([ref]$pdfPath, [ref]17)
    $doc.Close()
    $word.Quit()
    Write-Host "SUCCESS: PDF created successfully at $pdfPath"
} catch {
    Write-Host "WORD COM ERROR: $($_.Exception.Message)"
}
