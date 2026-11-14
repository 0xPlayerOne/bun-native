// Offline OCR of one captured image; no window, screen, or input access.
// The controller owns capture and timestamps; recognition is not presentation.
#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <ImageIO/ImageIO.h>
#import <Vision/Vision.h>

static int fail(NSString *message) {
    fprintf(stderr, "%s\n", message.UTF8String);
    return 1;
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc != 2) return fail(@"Expected one absolute image path");
        NSString *path = [NSString stringWithUTF8String:argv[1]];
        if (!path.isAbsolutePath) return fail(@"Image path must be absolute");
        NSDictionary *attributes = [NSFileManager.defaultManager attributesOfItemAtPath:path error:NULL];
        unsigned long long bytes = [attributes fileSize];
        if (![attributes.fileType isEqualToString:NSFileTypeRegular] || bytes == 0 || bytes > 16777216)
            return fail(@"Image must be a nonempty regular file of at most 16 MiB");
        CGImageSourceRef source = CGImageSourceCreateWithURL((__bridge CFURLRef)[NSURL fileURLWithPath:path], NULL);
        if (!source) return fail(@"Cannot open image");
        NSDictionary *properties = CFBridgingRelease(CGImageSourceCopyPropertiesAtIndex(source, 0, NULL));
        NSUInteger declaredWidth = [properties[(__bridge NSString *)kCGImagePropertyPixelWidth] unsignedIntegerValue];
        NSUInteger declaredHeight = [properties[(__bridge NSString *)kCGImagePropertyPixelHeight] unsignedIntegerValue];
        if (!declaredWidth || !declaredHeight || declaredWidth > 8192 || declaredHeight > 8192) {
            CFRelease(source);
            return fail(@"Image dimensions exceed the bounded observer");
        }
        CGImageRef image = CGImageSourceCreateImageAtIndex(source, 0, NULL);
        CFRelease(source);
        if (!image) return fail(@"Cannot decode image");
        size_t width = CGImageGetWidth(image), height = CGImageGetHeight(image);
        if (width != declaredWidth || height != declaredHeight) {
            CGImageRelease(image);
            return fail(@"Decoded image dimensions do not match its metadata");
        }
        VNRecognizeTextRequest *request = [VNRecognizeTextRequest new];
        request.recognitionLevel = VNRequestTextRecognitionLevelFast;
        request.usesLanguageCorrection = NO;
        request.recognitionLanguages = @[@"en-US"];
        VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithCGImage:image options:@{}];
        NSError *error = nil;
        NSTimeInterval start = NSProcessInfo.processInfo.systemUptime;
        BOOL ok = [handler performRequests:@[request] error:&error];
        double elapsed = (NSProcessInfo.processInfo.systemUptime - start) * 1000;
        CGImageRelease(image);
        if (!ok) return fail(error.localizedDescription ?: @"Vision text recognition failed");
        if (request.results.count > 256) return fail(@"Too many recognized text regions");
        NSMutableArray *observations = [NSMutableArray array];
        for (VNRecognizedTextObservation *observation in request.results) {
            VNRecognizedText *candidate = [observation topCandidates:1].firstObject;
            if (!candidate || candidate.string.length > 512) return fail(@"Invalid recognized text");
            CGRect box = observation.boundingBox;
            [observations addObject:@{@"text": candidate.string, @"confidence": @(candidate.confidence),
                @"bounds": @[@(box.origin.x), @(box.origin.y), @(box.size.width), @(box.size.height)]}];
        }
        NSDictionary *result = @{@"status": @"passed", @"size": @[@(width), @(height)],
            @"recognitionMs": @(elapsed), @"observations": observations,
            @"boundsOrigin": @"normalized bottom-left"};
        NSData *encoded = [NSJSONSerialization dataWithJSONObject:result options:0 error:NULL];
        if (!encoded || encoded.length > 131072) return fail(@"Cannot encode bounded OCR result");
        fwrite(encoded.bytes, 1, encoded.length, stdout);
        fputc('\n', stdout);
        return 0;
    }
}
