#include "utils.h"

void wfes::utils::writeMatrixToFile(const dmat &A, std::string name, std::string executableName, bool append) {
    QString outputPath(QStandardPaths::writableLocation(QStandardPaths::DocumentsLocation) + "/Wfes/");
    QDir dir;

    if(!dir.exists(outputPath))
        dir.mkpath(outputPath);

    // Get names of files in directory.
    QStringList fileNames = wfes::utils::listFiles(outputPath, "*.csv");

    // Get name without extension.
    QString nameWithoutExtension = QString::fromStdString(name).split(".")[0] + QString::fromStdString("-" + executableName);

    // Get num of files of which this name is preffix.
    int num_prefix = wfes::utils::numPreffix(nameWithoutExtension, fileNames);

    name = nameWithoutExtension.toStdString() + "-" + std::to_string(num_prefix) + ".csv";

    QFile file(outputPath + QString::fromStdString(name));
    file.open(QIODevice::WriteOnly);

    if(!file.isOpen()) {
        qDebug() << "The file is not open.";
    }

    QTextStream outStream(&file);
    std::stringstream stream;
    stream << A.format(CSVFormat);
    outStream << QString::fromStdString(stream.str());

    file.close();
}

void wfes::utils::writeVectorMapToFile(const std::map<llong, dvec> &A, std::string name, std::string executableName, bool append) {
    QString outputPath(QStandardPaths::writableLocation(QStandardPaths::DocumentsLocation) + "/Wfes/");
    QDir dir;

    if (!dir.exists(outputPath))
        dir.mkpath(outputPath);

    // Get names of files in directory.
    QStringList fileNames = wfes::utils::listFiles(outputPath, "*.csv");

    // Get name without extension.
    QString nameWithoutExtension = QString::fromStdString(name).split(".")[0] + QString::fromStdString("-" + executableName);

    // Get num of files of which this name is preffix.
    int num_prefix = wfes::utils::numPreffix(nameWithoutExtension, fileNames);

    name = nameWithoutExtension.toStdString() + "-" + std::to_string(num_prefix) + ".csv";

    QFile file(outputPath + QString::fromStdString(name));
    file.open(QIODevice::WriteOnly);

    if(!file.isOpen()) {
        qDebug() << "The file is not open.";
    }

    QTextStream outStream(&file);
    std::stringstream stream;

    for(auto const &item : A) {
        llong key = item.first;
        dvec value = item.second;
        stream << key<< ", " << value.format(CSVRowFormat) << std::endl;
    }

    outStream << QString::fromStdString(stream.str());

    file.close();

}

void wfes::utils::writeVectorToFile(const dvec &A, std::string name, std::string executableName, bool append) {
    QString outputPath(QStandardPaths::writableLocation(QStandardPaths::DocumentsLocation) + "/Wfes/");
    QDir dir;

    if (!dir.exists(outputPath))
        dir.mkpath(outputPath);

    // Get names of files in directory.
    QStringList fileNames = wfes::utils::listFiles(outputPath, "*.csv");

    // Get name without extension.
    QString nameWithoutExtension = QString::fromStdString(name).split(".")[0] + QString::fromStdString("-" + executableName);

    // Get num of files of which this name is preffix.
    int num_prefix = wfes::utils::numPreffix(nameWithoutExtension, fileNames);

    name = nameWithoutExtension.toStdString() + "-" + std::to_string(num_prefix) + ".csv";

    QFile file(outputPath + QString::fromStdString(name));
    file.open(QIODevice::WriteOnly);

    if(!file.isOpen()) {
        qDebug() << "The file is not open.";
    }

    QTextStream outStream(&file);
    std::stringstream stream;
    stream << A.format(CSVFormat);

    outStream << QString::fromStdString(stream.str());

    file.close();
}

void wfes::utils::printVector(const dvec &src, const char *prefix, const char *postfix, const char *delim) {
    size_t size = src.size();
    printf("%s", prefix);
    for(size_t i = 0; i < size - 1; i++) {
        printf(DPF, src(i));
        printf("%s ", delim);
    }
    printf(DPF, src(size-1));
    printf("%s", postfix);
}

void wfes::utils::printVector(const lvec &src, const char *prefix, const char *postfix, const char *delim) {
    size_t size = src.size();
    printf("%s", prefix);
    for(size_t i = 0; i < size - 1; i++) {
        printf(LPF, src(i));
        printf("%s ", delim);
    }
    printf(LPF, src(size-1));
    printf("%s", postfix);
}

llong wfes::utils::positiveMin(llong a, llong b) {
    if (a == 0 && b == 0) return 0;
    if (a >= 0 && b <  0) return a;
    if (a <  0 && b >= 0) return b;
    if (a <= b) return a;
    else return b;
}

bool wfes::utils::approxEq(const dvec &a, const dvec &b, double tol) {
    return ((a - b).array().abs() < tol).all();
}

bool wfes::utils::approxEq(const dmat &a, const dmat &b, double tol) {
    return ((a - b).array().abs() < tol).all();
}

double wfes::utils::totalDiff(const dmat &a, const dmat &b) {
    return (a - b).array().abs().sum();
}

lvec wfes::utils::startIndeces(lvec n) {
    lvec si = lvec::Zero(n.size());
    for (llong i = 1; i < n.size(); i++) {
        si[i] = si[i-1] + n[i-1];
    }
    return si;
}

lvec wfes::utils::endIndeces(lvec n) {
    lvec ei = lvec::Zero(n.size());
    ei(0) = n[0];
    for (llong i = 1; i < n.size(); i++) {
        ei[i] = ei[i-1] + n[i];
    }
    return ei;
}

lvec wfes::utils::rangeStep(llong a, llong b, llong s) {
    lvec r = lvec::Zero(ceil((b-a)/double(s)));
    for(llong v = a, i = 0; v < b; v += s, i++) {
        r[i] = v;
    }
    return r;
}

lvec wfes::utils::closedRange(llong start, llong stop) {
    lvec r(stop - start + 1);
    for(llong i = start; i <= stop; i++) r(i - start) = i;
    return r;
}

ivec wfes::utils::closedRangeInt(int start, int stop) {
    ivec r(stop - start + 1);
    for(int i = start; i <= stop; i++) r(i - start) = i;
    return r;
}

QImage* wfes::utils::generateImage(const dmat &a) {
    // Get minimum and maximum value
    double max = std::numeric_limits<double>::min();
    double min = std::numeric_limits<double>::max();
    for(int i = 0; i < a.rows(); i++){
        for(int j = 0; j < a.cols(); j++){
            if(a(i, j) < min)
                min = a(i, j);
            if(a(i, j) > max)
                max = a(i, j);
        }
    }

    // Allocate vector of uchar to store pixel values.
    uchar* data = (uchar*) malloc(a.rows() * a.cols() * sizeof(uchar));

    // Get number of bytes per each row.
    int bytesPerLine = (a.rows() * a.cols() * sizeof(uchar)) / a.rows();

    // Calculate pixel values using min and max.
    for(int i = (a.rows() * a.cols()) - 1; i >= 0 ; i--) {
        if(QThread::currentThread()->isInterruptionRequested()) {
            return new QImage();
        }

        double val = a.data()[i] + std::abs(min);
        val = val * 255;
        val = val / (std::abs(min + max));
        // Invert pixel values so higher values are darker.
        data[i] = (uchar) std::abs(255-(val));
    }

    // Create QImage using vector of pixels.
    QImage* image = new QImage(data, a.cols(), a.rows(), bytesPerLine, QImage::Format_Grayscale8);

    return image;
}


bool wfes::utils::saveImage(QImage *image, std::string path) {
    return image->save(QString::fromStdString(path), "PNG");
}

int wfes::utils::numPreffix(QString preffix, QStringList list) {
    int num_prefix = 0;
    for(int i = 0; i < list.size(); i++) {
        //Check if prefix
        int index = 0;
        bool isPrefix = true;
        if(preffix.size() > list[i].size()) {
            isPrefix = false;
        } else {
            while(index < preffix.size()) {
                if(list[i].at(index) != preffix.at(index)) {
                    isPrefix = false;
                }
                index++;
            }
        }
        if(isPrefix)
            num_prefix++;
    }
    return num_prefix;
}

QStringList wfes::utils::listFiles(QString filePath, QString pattern) {
    // Check for existing files, so those are not overwritten.
    QDirIterator it(filePath, QStringList() << pattern, QDir::Files, QDirIterator::Subdirectories);
    QStringList fileNames;
    while (it.hasNext()) {
        QStringList splitted = it.next().split("/");
        fileNames.append(splitted[splitted.size()-1].split(".")[0]);
    }
    return fileNames;
}

void wfes::utils::writeSparseMatrixToFile(wfes::sparsematrix::SparseMatrix *A, std::string name, std::string executableName, bool append){
    QString outputPath(QStandardPaths::writableLocation(QStandardPaths::DocumentsLocation) + "/Wfes/");
    QDir dir;

    if (!dir.exists(outputPath))
        dir.mkpath(outputPath);

    // Get names of files in directory.
    QStringList fileNames = wfes::utils::listFiles(outputPath, "*.csv");

    // Get name without extension.
    QString nameWithoutExtension = QString::fromStdString(name).split(".")[0] + QString::fromStdString("-" + executableName);

    // Get num of files of which this name is preffix.
    int num_prefix = wfes::utils::numPreffix(nameWithoutExtension, fileNames);

    name = nameWithoutExtension.toStdString() + "-" + std::to_string(num_prefix) + ".csv";

    A->saveMarket(name);

}

int wfes::utils::executionStatusToInt(wfes::utils::ExecutionStatus status) {
    switch(status) {
    case NONE:
        return 0;
    case STARTING:
        return 1;
    case BUILDING_MATRICES:
        return 2;
    case SOLVING_MATRICES:
        return 3;
    case SAVING_DATA:
        return 4;
    case DONE:
        return 5;
    case EXECUTION_ERROR:
        return 6;
    case ABORTED:
        return 7;
    default:
        return -1;
    }
}
