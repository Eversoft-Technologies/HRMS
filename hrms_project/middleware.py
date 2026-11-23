"""Project middleware."""
from django.middleware.gzip import GZipMiddleware

# Only text compresses well. Images, video, audio, PDFs and archives are
# already compressed, and compressing a partial (Range) response would break
# seeking in interview recordings, so those are passed through untouched.
_COMPRESSIBLE = (
    'application/json',
    'application/javascript',
    'text/',
    'image/svg+xml',
    'application/xml',
)


class TextGZipMiddleware(GZipMiddleware):
    """gzip for API JSON and the app's JS / CSS / HTML only.

    The API returns plain JSON and the React build is served as-is, so without
    this every list response and the ~700 KB app bundle cross the network at
    full size. Typical saving is 70-85 %.
    """

    def process_request(self, request):
        # Compressing a response turns its ETag into a weak one (W/"..."), and
        # the browser sends that back on a reload to ask "has it changed?".
        # WhiteNoise only recognises its own strong form, so without this it
        # answered every reload by sending all ~60 app files again instead of
        # "304 Not Modified". A weak match is exactly what a revalidation needs.
        etag = request.META.get('HTTP_IF_NONE_MATCH')
        if etag and 'W/' in etag:
            request.META['HTTP_IF_NONE_MATCH'] = etag.replace('W/', '')
        return None

    def process_response(self, request, response):
        if response.status_code != 200 or request.headers.get('Range'):
            return response
        content_type = (response.get('Content-Type') or '').lower()
        if not content_type.startswith(_COMPRESSIBLE):
            return response
        return super().process_response(request, response)
