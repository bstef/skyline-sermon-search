"""Read explicit speaker credits; never treat the podcast publisher as a preacher."""
import html
from html.parser import HTMLParser
import re


class PlainText(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []

    def handle_data(self, data):
        self.parts.append(data)

    def handle_starttag(self, tag, attrs):
        if tag in ('p', 'br', 'div', 'li'):
            self.parts.append('\n')

    def handle_endtag(self, tag):
        if tag in ('p', 'div', 'li'):
            self.parts.append('\n')


def plain(value):
    parser = PlainText()
    parser.feed(value or '')
    return html.unescape(''.join(parser.parts)).replace('\u2060', '').strip()


def person(value):
    value = ' '.join(value.split()).strip(' ,:–-')
    words = value.split()
    if not 2 <= len(words) <= 5:
        return ''
    # Conservative name-shaped credits only, including accents and apostrophes.
    if not all(re.fullmatch(r"[^\W\d_][^\W\d_’'.-]*\.?", word) and word[0].isupper() for word in words):
        return ''
    if any(word.lower() in {'church', 'skyline', 'ministry', 'ministries', 'podcast', 'grace'} for word in words):
        return ''
    return value


def speaker_credit(item):
    # Podcast Index's explicit person roles distinguish speakers from hosts.
    names = []
    for tag in item.findall('{https://podcastindex.org/namespace/1.0}person'):
        if tag.get('role', '').lower() in {'speaker', 'preacher'}:
            name = person(plain(tag.text))
            if name and name not in names:
                names.append(name)
    if names:
        return ' & '.join(names), 'podcast:person'
    title = plain(item.findtext('title'))
    description = plain(item.findtext('description') or item.findtext('{http://www.itunes.com/dtds/podcast-1.0.dtd}summary'))
    for source, text in [('title', title), ('description', description)]:
        match = re.search(r'(?:^|\n)\s*(?:Speaker|Preacher|Message by|Sermon by|Preached by)\s*:?\s+([^\n|;!?]+)', text, re.I)
        if match and (name := person(match[1].rstrip('.'))):
            return name, source
    # Explicit attribution in a title, rather than arbitrary names in the text.
    match = re.search(r'\s[-–|]\s(?:by|Speaker:|Preacher:)\s+(.+?)\s*$', title, re.I)
    if match and (name := person(match[1])):
        return name, 'title'
    # These narrative credits are present in Skyline's archive.
    match = re.match(r'(Pastor .+?) is joined by (.+?) for\b', description)
    if match and (first := person(match[1])) and (second := person(match[2])):
        return first + ' & ' + second, 'description'
    match = re.search(r'includes input from some of the elders of our church along with (Pastor [^.!?\n]+)', description)
    if match and (name := person(match[1])):
        return name + ' & church elders', 'description'
    return '', ''
