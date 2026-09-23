# Windows built-in OCR worker for scanned PDFs.
#
# Rasterizes pages with Windows.Data.Pdf and recognizes them with Windows.Media.Ocr.
# Both are part of Windows 10/11, so there is nothing to install - no tesseract,
# no traineddata, no ghostscript/poppler.
#
# IMPORTANT: keep this file pure ASCII. Windows PowerShell 5.1 reads .ps1 as the
# system ANSI codepage unless the file has a BOM, so any non-ASCII literal here
# (including Korean comments) gets mangled at parse time and breaks the script.
# Korean only ever appears in the OCR *output*, which is written as UTF-8 JSON.
#
# Output: a UTF-8 JSON file { "pageCount": n, "pages": [ { "page": 1, "text": "..." } ], "error": null }

param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Out,
    [int]$StartPage = 1,
    [int]$MaxPages = 0,
    [int]$Width = 2000,
    [string]$Language = "ko",
    [string]$OnlyPages = ""
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null

[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Pdf.PdfPageRenderOptions, Windows.Data.Pdf, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType = WindowsRuntime] | Out-Null
[Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null

$methods = [System.WindowsRuntimeSystemExtensions].GetMethods()
$asTaskOp = ($methods | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
$asTaskAct = ($methods | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction'
})[0]

function Await($op, $type) {
    $task = $asTaskOp.MakeGenericMethod($type).Invoke($null, @($op))
    try { $task.Wait(-1) | Out-Null } catch { throw $_.Exception.InnerException }
    $task.Result
}
function AwaitAction($action) {
    $task = $asTaskAct.Invoke($null, @($action))
    try { $task.Wait(-1) | Out-Null } catch { throw $_.Exception.InnerException }
}

function Write-Result($obj) {
    $json = $obj | ConvertTo-Json -Depth 5 -Compress
    [IO.File]::WriteAllText($Out, $json, (New-Object Text.UTF8Encoding($false)))
}

try {
    $storageFile = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)) ([Windows.Storage.StorageFile])
    $pdf = Await ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($storageFile)) ([Windows.Data.Pdf.PdfDocument])

    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language $Language))
    if ($null -eq $engine) {
        # The language pack is not installed. Fall back to whatever the user profile offers
        # rather than failing outright - a wrong-language OCR still beats no text at all.
        $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    }
    if ($null -eq $engine) {
        Write-Result @{ pageCount = [int]$pdf.PageCount; pages = @(); error = "no-ocr-engine" }
        exit 0
    }

    # Explicit page list wins over the start/max range. Used to OCR only the pages
    # whose embedded text layer came back empty, instead of the whole document.
    $targets = @()
    if ($OnlyPages -ne "") {
        foreach ($p in $OnlyPages.Split(",")) {
            $n = 0
            if ([int]::TryParse($p.Trim(), [ref]$n) -and $n -ge 1 -and $n -le $pdf.PageCount) { $targets += $n }
        }
    } else {
        $last = [int]$pdf.PageCount
        if ($MaxPages -gt 0) { $last = [Math]::Min($last, $StartPage + $MaxPages - 1) }
        for ($n = $StartPage; $n -le $last; $n++) { $targets += $n }
    }

    $opts = New-Object Windows.Data.Pdf.PdfPageRenderOptions
    $opts.DestinationWidth = [uint32]$Width

    $pages = @()
    foreach ($n in $targets) {
        $page = $pdf.GetPage([uint32]($n - 1))
        $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
        try {
            AwaitAction ($page.RenderToStreamAsync($stream, $opts))
            $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
            $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
            $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
            $pages += @{ page = $n; text = $result.Text }
            if ($null -ne $bitmap.PSObject.Methods['Dispose']) { $bitmap.Dispose() }
        } catch {
            # One unreadable page must not lose the other 106.
            $pages += @{ page = $n; text = ""; error = $_.Exception.Message }
        } finally {
            # PdfPage/SoftwareBitmap are IDisposable, but the PowerShell projection does not
            # expose Close(). Dispose() may also be absent depending on the Windows build,
            # so probe for it instead of calling it blindly - a failure here would otherwise
            # throw away a page that was recognized just fine.
            if ($null -ne $stream.PSObject.Methods['Dispose']) { $stream.Dispose() }
            if ($null -ne $page.PSObject.Methods['Dispose']) { $page.Dispose() }
        }
    }

    Write-Result @{ pageCount = [int]$pdf.PageCount; pages = $pages; error = $null }
} catch {
    Write-Result @{ pageCount = 0; pages = @(); error = ($_.Exception.GetType().Name + ": " + $_.Exception.Message) }
}
