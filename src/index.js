const AWS = require('aws-sdk');
const JSZip = require("jszip");

const s3 = new AWS.S3();
const codepipeline = new AWS.CodePipeline();

var jobId = undefined;
var context = undefined;

// Notify AWS CodePipeline of a successful job
const putJobSuccess = function (message) {
    let params = {
        jobId: jobId
    };
    codepipeline.putJobSuccessResult(params, function (err, data) {
        if (err) {
            context.fail(err);
        } else {
            context.succeed(message);
        }
    });
};

// Notify AWS CodePipeline of a failed job
const putJobFailure = function (message) {
    let params = {
        jobId: jobId,
        failureDetails: {
            message: JSON.stringify(message),
            type: 'JobFailed',
            externalExecutionId: context.invokeid
        }
    };
    codepipeline.putJobFailureResult(params, function (err, data) {
        context.fail(message);
    });
};

// Retrieve an artifact from S3
const getArtifact = function (bucket, key) {
    return new Promise((resolve, reject) => {
        s3.getObject({ Bucket: bucket, Key: key }, function (error, data) {
            if (error != null) {
                console.log("Failed to retrieve from S3: " + bucket + key);
                reject(error);
            } else {
                console.log(bucket + key + " fetched. " + data.ContentLength + " bytes");
                resolve(data.Body);
            }
        });
    });
};

// Put an artifact on S3
const putArtifact = function (bucket, key, artifact) {
    return new Promise((resolve, reject) => {
        let params = {
            Body: artifact,
            Bucket: bucket,
            ContentType: "application/zip",
            Key: key,
            ServerSideEncryption: "AES256"
        };

        s3.putObject(params, function (error, data) {
            if (error) {
                reject(error);
            } else {
                resolve();
            }
        });
    });
};

// Merges zip files synchronously in a recursive manner (Await/Async when Lambda supports Node8?)
const mergeArtifacts = function (output_artifact, input_artifacts, index) {
    return new Promise((resolve, reject) => {
        // Load the current zip artifact into our output zip
        output_artifact.loadAsync(input_artifacts[index]).then(updated_output_artifact => {
            index += 1;
            if (index < input_artifacts.length) {
                // Process next zip artifact
                mergeArtifacts(updated_output_artifact, input_artifacts, index).then(next_output_artifact => {
                    resolve(next_output_artifact);
                });
            } else {
                // Last recursive call should drop here
                resolve(updated_output_artifact);
            }
        // JSZip: "The promise can fail if the loaded data is not valid zip data or if it uses unsupported features (multi volume, password protected, etc)."
        }).catch((error) => {
            reject(error);
        });
    });
};

exports.handler = function (event, _context) {
    // Retrieve the Job ID from the Lambda action
    jobId = event["CodePipeline.job"].id;
    context = _context;

    // [Optional] parameters to customize function if needed later on, not currently used.
    let url = event["CodePipeline.job"].data.actionConfiguration.configuration.UserParameters;

    // CodePipeline event meta data
    let job_meta = event['CodePipeline.job']['data'];
    let input_artifacts_meta = job_meta['inputArtifacts'];
    let output_artifacts_meta = job_meta['outputArtifacts'];

    // Artifact - S3 download promises
    let await_input_artifacts = [];

    try {
        // Download all input artifacts from S3
        for (let artifact of input_artifacts_meta) {
            await_input_artifacts.push(getArtifact(artifact.location.s3Location.bucketName, artifact.location.s3Location.objectKey));
        }

        // Wait till all input artifacts are fetched.
        Promise.all(await_input_artifacts).then(input_artifacts => {
            console.log(input_artifacts.length + " artifacts fetched.");

            var new_zip = new JSZip();
            // Merge zipped input artifacts into a single zipped output artifact
            mergeArtifacts(new_zip, input_artifacts, 0).then(merged_zip => {
                // Encode the merged output artifact then upload to S3    
                merged_zip.generateAsync({ type: "nodebuffer" }).then(output_artifact_body => {
                    let output_artifact = output_artifacts_meta[0].location.s3Location;
                    putArtifact(output_artifact.bucketName, output_artifact.objectKey, output_artifact_body).then(() => {
                        console.log("Merged artifacts successfully and uploaded to S3.");
                        putJobSuccess("Merged artifacts successfully.");
                    }).catch((error) => {
                        console.log("S3 put error: " + error);
                        putJobFailure("Failed to upload output artifact to S3.");
                    });
                });
            }).catch((error) => {
                console.log("JSZip error: " + error);
                putJobFailure("Failed to load zipped artifact.");
            });
        }).catch((error) => {
            console.log("S3 get error: " + error);
            putJobFailure("Failed to retrieve an object from S3.");
        });
    } catch (error) {
        console.log(error);
        putJobFailure("Unknown error: check CloudWatch logs.");
    }
};
