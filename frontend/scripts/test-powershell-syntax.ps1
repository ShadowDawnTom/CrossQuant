param(
    [Parameter(Mandatory = $true, ValueFromRemainingArguments = $true)]
    [string[]]$Files
)

$Failed = $false
foreach ($File in $Files) {
    $Tokens = $null
    $Errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile(
        [IO.Path]::GetFullPath($File),
        [ref]$Tokens,
        [ref]$Errors
    )
    if ($Errors.Count -gt 0) {
        $Failed = $true
        foreach ($ParserError in $Errors) {
            Write-Error "$File`: $($ParserError.Message)"
        }
    }
}
if ($Failed) { exit 1 }
