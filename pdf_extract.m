#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#import <PDFKit/PDFKit.h>
#import <Vision/Vision.h>

static NSString *ExtractTextFromDocument(PDFDocument *document);
static NSString *OCRTextFromPage(PDFPage *page, NSError **error);

int main(int argc, const char * argv[]) {
    @autoreleasepool {
        if (argc != 2) {
            fprintf(stderr, "Usage: pdf_extract <file.pdf>\n");
            return 1;
        }

        NSString *path = [NSString stringWithUTF8String:argv[1]];
        PDFDocument *document = [[PDFDocument alloc] initWithURL:[NSURL fileURLWithPath:path]];
        if (!document) {
            fprintf(stderr, "PDF extraction failed: cannot open document\n");
            return 1;
        }

        NSString *text = ExtractTextFromDocument(document);
        NSData *output = [text dataUsingEncoding:NSUTF8StringEncoding];
        [[NSFileHandle fileHandleWithStandardOutput] writeData:output];
    }

    return 0;
}

static NSString *ExtractTextFromDocument(PDFDocument *document) {
    NSString *directText = [document string];
    if (directText.length > 400) {
        return directText;
    }

    NSMutableArray<NSString *> *pages = [NSMutableArray array];
    for (NSInteger index = 0; index < document.pageCount; index += 1) {
        PDFPage *page = [document pageAtIndex:index];
        if (!page) {
            continue;
        }

        NSError *error = nil;
        NSString *pageText = OCRTextFromPage(page, &error);
        if (pageText.length > 0) {
            [pages addObject:pageText];
        }
    }

    return [pages componentsJoinedByString:@"\n\n"];
}

static NSString *OCRTextFromPage(PDFPage *page, NSError **error) {
    NSSize targetSize = NSMakeSize(1800, 2500);
    NSImage *image = [page thumbnailOfSize:targetSize forBox:kPDFDisplayBoxMediaBox];
    if (!image) {
        if (error) {
            *error = [NSError errorWithDomain:@"RosterOverlap" code:2 userInfo:@{NSLocalizedDescriptionKey: @"Could not render PDF page"}];
        }
        return @"";
    }

    CGImageRef cgImage = [image CGImageForProposedRect:NULL context:nil hints:nil];
    if (!cgImage) {
        if (error) {
            *error = [NSError errorWithDomain:@"RosterOverlap" code:3 userInfo:@{NSLocalizedDescriptionKey: @"Could not create CGImage"}];
        }
        return @"";
    }

    VNRecognizeTextRequest *request = [[VNRecognizeTextRequest alloc] init];
    request.recognitionLevel = VNRequestTextRecognitionLevelAccurate;
    request.usesLanguageCorrection = NO;
    request.minimumTextHeight = 0.006;
    request.recognitionLanguages = @[@"en-AU", @"en-US"];

    VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithCGImage:cgImage options:@{}];
    if (![handler performRequests:@[request] error:error]) {
        return @"";
    }

    NSArray<VNRecognizedTextObservation *> *results = request.results ?: @[];
    NSArray<VNRecognizedTextObservation *> *sorted = [results sortedArrayUsingComparator:^NSComparisonResult(VNRecognizedTextObservation *a, VNRecognizedTextObservation *b) {
        CGFloat yDelta = fabs(a.boundingBox.origin.y - b.boundingBox.origin.y);
        if (yDelta > 0.012) {
            return a.boundingBox.origin.y > b.boundingBox.origin.y ? NSOrderedAscending : NSOrderedDescending;
        }
        if (a.boundingBox.origin.x < b.boundingBox.origin.x) {
            return NSOrderedAscending;
        }
        if (a.boundingBox.origin.x > b.boundingBox.origin.x) {
            return NSOrderedDescending;
        }
        return NSOrderedSame;
    }];

    NSMutableArray<NSString *> *lines = [NSMutableArray array];
    for (VNRecognizedTextObservation *observation in sorted) {
        VNRecognizedText *candidate = [[observation topCandidates:1] firstObject];
        if (candidate.string.length > 0) {
            [lines addObject:candidate.string];
        }
    }

    return [lines componentsJoinedByString:@"\n"];
}
